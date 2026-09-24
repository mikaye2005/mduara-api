import { createHash, createHmac } from 'node:crypto';
import { env } from '../config/env';
import { ServiceUnavailableError } from '../utils/errors';

export interface ObjectHead {
  contentLength: number;
  contentType: string | null;
  etag: string | null;
  uploadId: string | null;
}

export interface SignedObjectUrl {
  url: string;
  expiresAt: string;
}

export interface SignedUploadForm extends SignedObjectUrl {
  method: 'POST';
  fields: Record<string, string>;
}

export interface ObjectStorageAdapter {
  createUploadForm(input: { objectKey: string; uploadId: string; mimeType: string; sizeBytes: number; expiresSeconds?: number }): SignedUploadForm;
  createDownloadUrl(objectKey: string, fileName: string, options?: { inline?: boolean; expiresSeconds?: number }): SignedObjectUrl;
  headObject(objectKey: string): Promise<ObjectHead | null>;
  deleteObject(objectKey: string): Promise<void>;
}

interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
}

export class S3CompatibleObjectStorage implements ObjectStorageAdapter {
  constructor(private readonly config: StorageConfig) {}

  createUploadForm(input: { objectKey: string; uploadId: string; mimeType: string; sizeBytes: number; expiresSeconds?: number }): SignedUploadForm {
    const now = new Date();
    const expiresSeconds = input.expiresSeconds ?? this.config.uploadTtlSeconds;
    const expiresAt = new Date(now.getTime() + expiresSeconds * 1000);
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const credential = `${this.config.accessKeyId}/${scope}`;
    const conditions: unknown[] = [
      { bucket: this.config.bucket },
      ['eq', '$key', input.objectKey],
      ['eq', '$Content-Type', input.mimeType],
      ['eq', '$x-amz-meta-upload-id', input.uploadId],
      ['content-length-range', input.sizeBytes, input.sizeBytes],
      { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
      { 'x-amz-credential': credential },
      { 'x-amz-date': amzDate },
    ];
    if (this.config.sessionToken) conditions.push({ 'x-amz-security-token': this.config.sessionToken });
    const policy = Buffer.from(JSON.stringify({ expiration: expiresAt.toISOString(), conditions })).toString('base64');
    const signature = createHmac('sha256', deriveSigningKey(this.config.secretAccessKey, dateStamp, this.config.region, 's3')).update(policy).digest('hex');
    const fields: Record<string, string> = {
      key: input.objectKey,
      'Content-Type': input.mimeType,
      'x-amz-meta-upload-id': input.uploadId,
      'x-amz-algorithm': 'AWS4-HMAC-SHA256',
      'x-amz-credential': credential,
      'x-amz-date': amzDate,
      policy,
      'x-amz-signature': signature,
    };
    if (this.config.sessionToken) fields['x-amz-security-token'] = this.config.sessionToken;
    return { url: this.bucketUrl().toString(), method: 'POST', fields, expiresAt: expiresAt.toISOString() };
  }

  createDownloadUrl(
    objectKey: string,
    fileName: string,
    options: { inline?: boolean; expiresSeconds?: number } = {},
  ): SignedObjectUrl {
    const disposition = `${options.inline ? 'inline' : 'attachment'}; filename="${sanitizeDispositionFileName(fileName)}"`;
    return this.presign('GET', objectKey, options.expiresSeconds ?? this.config.downloadTtlSeconds, {
      'response-content-disposition': disposition,
    });
  }

  async headObject(objectKey: string): Promise<ObjectHead | null> {
    const signed = this.presign('HEAD', objectKey, 60);
    let response: Response;
    try {
      response = await fetch(signed.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new ServiceUnavailableError(`Object storage HEAD request failed: ${error instanceof Error ? error.message : String(error)}`, 'OBJECT_STORAGE_UNAVAILABLE');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ServiceUnavailableError(`Object storage HEAD request failed with status ${response.status}`, 'OBJECT_STORAGE_UNAVAILABLE');
    }
    const rawLength = response.headers.get('content-length');
    const contentLength = rawLength ? Number(rawLength) : Number.NaN;
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new ServiceUnavailableError('Object storage did not return a valid content length', 'OBJECT_STORAGE_INVALID_METADATA');
    }
    return {
      contentLength,
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag')?.replace(/^"|"$/g, '') ?? null,
      uploadId: response.headers.get('x-amz-meta-upload-id'),
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    const signed = this.presign('DELETE', objectKey, 60);
    let response: Response;
    try {
      response = await fetch(signed.url, { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new ServiceUnavailableError(`Object storage DELETE request failed: ${error instanceof Error ? error.message : String(error)}`, 'OBJECT_STORAGE_UNAVAILABLE');
    }
    if (![200, 204, 404].includes(response.status)) {
      throw new ServiceUnavailableError(`Object storage DELETE request failed with status ${response.status}`, 'OBJECT_STORAGE_UNAVAILABLE');
    }
  }

  private presign(method: 'PUT' | 'GET' | 'HEAD' | 'DELETE', objectKey: string, expiresSeconds: number, extraQuery: Record<string, string> = {}): SignedObjectUrl {
    if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604800) {
      throw new ServiceUnavailableError('Invalid signed URL TTL', 'OBJECT_STORAGE_SIGNING_INVALID');
    }
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const url = this.objectUrl(objectKey);
    const query: Record<string, string> = {
      ...extraQuery,
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': 'host',
    };
    if (this.config.sessionToken) query['X-Amz-Security-Token'] = this.config.sessionToken;

    const canonicalQuery = canonicalizeQuery(query);
    const canonicalHeaders = `host:${url.host}\n`;
    const canonicalRequest = [
      method,
      canonicalUri(url.pathname),
      canonicalQuery,
      canonicalHeaders,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = deriveSigningKey(this.config.secretAccessKey, dateStamp, this.config.region, 's3');
    query['X-Amz-Signature'] = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    url.search = canonicalizeQuery(query);

    return {
      url: url.toString(),
      expiresAt: new Date(now.getTime() + expiresSeconds * 1000).toISOString(),
    };
  }

  private bucketUrl(): URL {
    const endpoint = new URL(this.config.endpoint);
    endpoint.search = '';
    endpoint.hash = '';
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    if (this.config.forcePathStyle) {
      endpoint.pathname = `${basePath}/${encodePathSegment(this.config.bucket)}`;
    } else {
      endpoint.hostname = `${this.config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = basePath || '/';
    }
    return endpoint;
  }

  private objectUrl(objectKey: string): URL {
    const endpoint = this.bucketUrl();
    const basePath = endpoint.pathname.replace(/\/+$/, '');
    endpoint.pathname = `${basePath}/${objectKey.split('/').map(encodePathSegment).join('/')}`;
    return endpoint;
  }
}

export function createDefaultObjectStorage(): ObjectStorageAdapter {
  if (!env.OBJECT_STORAGE_ENABLED) return new DisabledObjectStorage();
  return new S3CompatibleObjectStorage({
    endpoint: env.OBJECT_STORAGE_ENDPOINT!,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET!,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
    sessionToken: env.OBJECT_STORAGE_SESSION_TOKEN,
    forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
    uploadTtlSeconds: env.UPLOAD_SIGNED_URL_TTL_SECONDS,
    downloadTtlSeconds: env.DOWNLOAD_SIGNED_URL_TTL_SECONDS,
  });
}

class DisabledObjectStorage implements ObjectStorageAdapter {
  private unavailable(): never {
    throw new ServiceUnavailableError('File uploads are not configured for this environment', 'OBJECT_STORAGE_DISABLED');
  }
  createUploadForm(): SignedUploadForm { return this.unavailable(); }
  createDownloadUrl(): SignedObjectUrl { return this.unavailable(); }
  async headObject(): Promise<ObjectHead | null> { return this.unavailable(); }
  async deleteObject(): Promise<void> { return this.unavailable(); }
}

function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const regionKey = createHmac('sha256', dateKey).update(region).digest();
  const serviceKey = createHmac('sha256', regionKey).update(service).digest();
  return createHmac('sha256', serviceKey).update('aws4_request').digest();
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalizeQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join('&');
}

function canonicalUri(pathname: string): string {
  return pathname.split('/').map((segment) => rfc3986(decodeURIComponentSafely(segment))).join('/');
}

function encodePathSegment(value: string): string { return rfc3986(value); }
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function decodeURIComponentSafely(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
function sha256Hex(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sanitizeDispositionFileName(value: string): string {
  return value.replace(/[\r\n"\\]/g, '_').replace(/[^\x20-\x7E]/g, '_').slice(0, 180) || 'download';
}
