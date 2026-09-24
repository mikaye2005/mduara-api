import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { createDefaultObjectStorage, type ObjectStorageAdapter } from './object-storage.service';
import type { CreateUploadInput, ScanResultInput } from '../validation/upload.validation';

export type MediaUploadState = 'initiated' | 'scan_pending' | 'clean' | 'infected' | 'scan_failed' | 'rejected' | 'deleted';
type MediaUploadPurpose = 'profile_avatar' | 'chama_logo' | 'support_ticket_attachment';

interface UploadRow extends QueryResultRow {
  id: string;
  owner_user_id: string;
  purpose: MediaUploadPurpose;
  chama_id: string | null;
  support_ticket_id: string | null;
  original_filename: string;
  object_key: string;
  declared_mime_type: string;
  detected_mime_type: string | null;
  size_bytes: string;
  object_size_bytes: string | null;
  object_etag: string | null;
  state: MediaUploadState;
  upload_expires_at: string;
  uploaded_at: string | null;
  scan_requested_at: string | null;
  scan_claim_token: string | null;
  scan_claimed_until: string | null;
  scan_attempts: number;
  scanned_at: string | null;
  scan_provider: string | null;
  scan_reference: string | null;
  content_sha256: string | null;
  scan_last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TicketAccessRow extends QueryResultRow {
  id: string;
  user_id: string;
  chama_id: string | null;
  routing_target: 'platform_admin' | 'chama_chair';
  assigned_to: string | null;
}

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ATTACHMENT_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, 'application/pdf', 'text/plain']);
const MAX_SCAN_ATTEMPTS = 5;
const SCAN_LEASE_MINUTES = 5;

export class UploadService {
  constructor(
    private readonly db: Pool = pool,
    private readonly storage: ObjectStorageAdapter = createDefaultObjectStorage(),
  ) {}

  async createUpload(actorId: string, input: CreateUploadInput) {
    await this.assertCreateAuthorization(actorId, input);
    this.assertAllowedMime(input.purpose, input.mimeType);

    const uploadId = randomUUID();
    const safeFileName = sanitizeFileName(input.fileName);
    const objectKey = `uploads/${input.purpose}/${uploadId}/${safeFileName}`;
    const signed = this.storage.createUploadForm({
      objectKey, uploadId, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
      expiresSeconds: env.UPLOAD_SIGNED_URL_TTL_SECONDS,
    });

    const ticketChamaId = input.purpose === 'support_ticket_attachment'
      ? (await this.loadTicket(input.ticketId!)).chama_id
      : null;
    const chamaId = input.purpose === 'chama_logo' ? input.chamaId! : ticketChamaId;

    const row = (await this.db.query<UploadRow>(
      `INSERT INTO media_uploads
         (id, owner_user_id, purpose, chama_id, support_ticket_id, original_filename,
          object_key, declared_mime_type, size_bytes, upload_expires_at)
       VALUES ($1,$2,$3::media_upload_purpose,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${UPLOAD_SELECT_COLUMNS}`,
      [
        uploadId,
        actorId,
        input.purpose,
        chamaId,
        input.purpose === 'support_ticket_attachment' ? input.ticketId : null,
        safeFileName,
        objectKey,
        input.mimeType,
        input.sizeBytes,
        signed.expiresAt,
      ],
    )).rows[0];

    await this.audit('media_upload_created', actorId, row, {
      declaredMimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });

    return {
      upload: this.serialize(row),
      uploadUrl: signed.url,
      uploadExpiresAt: signed.expiresAt,
      uploadMethod: signed.method,
      uploadFields: signed.fields,
      completePath: `/api/v1/uploads/${uploadId}/complete`,
    };
  }

  async completeUpload(actorId: string, uploadId: string) {
    const current = await this.load(uploadId);
    if (current.owner_user_id !== actorId) {
      throw new ForbiddenError('Only the upload creator may complete this upload', 'UPLOAD_COMPLETE_FORBIDDEN');
    }
    if (current.state !== 'initiated') {
      if (current.state === 'scan_pending' || current.state === 'clean') return this.serialize(current);
      throw new ConflictError(`Upload cannot be completed from state ${current.state}`, 'UPLOAD_STATE_INVALID');
    }
    if (new Date(current.upload_expires_at).getTime() < Date.now()) {
      await this.rejectUpload(current, 'Upload URL expired before completion');
      throw new ConflictError('Upload URL has expired; create a new upload intent', 'UPLOAD_EXPIRED');
    }

    const head = await this.storage.headObject(current.object_key);
    if (!head) throw new NotFoundError('Uploaded object was not found in storage', 'UPLOAD_OBJECT_NOT_FOUND');
    const expectedSize = Number(current.size_bytes);
    const actualMime = normalizeMime(head.contentType);
    if (head.contentLength !== expectedSize || actualMime !== current.declared_mime_type || head.uploadId !== current.id) {
      await this.rejectUpload(
        current,
        `Storage metadata mismatch: expected ${expectedSize}/${current.declared_mime_type}/${current.id}, got ${head.contentLength}/${actualMime ?? 'unknown'}/${head.uploadId ?? 'missing-upload-id'}`,
      );
      await this.storage.deleteObject(current.object_key).catch(() => undefined);
      throw new ConflictError('Uploaded object metadata does not match the declared file', 'UPLOAD_METADATA_MISMATCH');
    }

    const row = await withDatabaseTransaction(async (client) => {
      const locked = await this.loadWith(client, uploadId, true);
      if (locked.owner_user_id !== actorId) throw new ForbiddenError('Upload completion denied', 'UPLOAD_COMPLETE_FORBIDDEN');
      if (locked.state !== 'initiated') return locked;
      const updated = (await client.query<UploadRow>(
        `UPDATE media_uploads
            SET state = 'scan_pending', object_size_bytes = $2, object_etag = $3,
                uploaded_at = CURRENT_TIMESTAMP, scan_requested_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING ${UPLOAD_SELECT_COLUMNS}`,
        [uploadId, head.contentLength, head.etag],
      )).rows[0];
      await this.auditWith(client, 'media_upload_scan_requested', actorId, updated, {});
      return updated;
    }, {}, this.db);

    return this.serialize(row);
  }

  async getUpload(actorId: string, uploadId: string) {
    const row = await this.load(uploadId);
    await this.assertCanAccess(actorId, row, false);
    return this.serialize(row);
  }

  async createDownload(actorId: string, uploadId: string, inline = true) {
    const row = await this.load(uploadId);
    await this.assertCanAccess(actorId, row, false);
    return this.signedDownload(row, inline);
  }

  async createContentRedirect(actorId: string | null, uploadId: string) {
    const row = await this.load(uploadId);
    await this.assertCanAccess(actorId, row, true);
    return this.signedDownload(row, row.purpose !== 'support_ticket_attachment');
  }

  async claimScans(limit: number) {
    const rows = await withDatabaseTransaction(async (client) => {
      return (await client.query<UploadRow>(
        `WITH candidates AS (
           SELECT id
             FROM media_uploads
            WHERE state = 'scan_pending'
              AND scan_attempts < $1
              AND (scan_claimed_until IS NULL OR scan_claimed_until < CURRENT_TIMESTAMP)
            ORDER BY scan_requested_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE media_uploads u
            SET scan_claim_token = gen_random_uuid(),
                scan_claimed_until = CURRENT_TIMESTAMP + ($3::text || ' minutes')::interval,
                scan_attempts = scan_attempts + 1,
                updated_at = CURRENT_TIMESTAMP
           FROM candidates c
          WHERE u.id = c.id
          RETURNING ${UPLOAD_SELECT_COLUMNS}`,
        [MAX_SCAN_ATTEMPTS, limit, SCAN_LEASE_MINUTES],
      )).rows;
    }, { isolationLevel: 'READ COMMITTED', maxRetries: 0 }, this.db);

    return rows.map((row) => {
      const signed = this.storage.createDownloadUrl(row.object_key, row.original_filename, {
        inline: false,
        expiresSeconds: SCAN_LEASE_MINUTES * 60,
      });
      return {
        id: row.id,
        purpose: row.purpose,
        fileName: row.original_filename,
        declaredMimeType: row.declared_mime_type,
        sizeBytes: Number(row.size_bytes),
        claimToken: row.scan_claim_token,
        claimExpiresAt: row.scan_claimed_until,
        scanAttempt: row.scan_attempts,
        downloadUrl: signed.url,
      };
    });
  }

  async recordScanResult(uploadId: string, input: ScanResultInput) {
    let objectToDelete: string | null = null;
    let supersededObjects: string[] = [];

    const row = await withDatabaseTransaction(async (client) => {
      const current = await this.loadWith(client, uploadId, true);
      if (current.state !== 'scan_pending') {
        if (['clean', 'infected', 'scan_failed'].includes(current.state)) return current;
        throw new ConflictError(`Upload is not awaiting a malware scan (${current.state})`, 'UPLOAD_SCAN_STATE_INVALID');
      }
      if (current.scan_claim_token !== input.claimToken
          || !current.scan_claimed_until
          || new Date(current.scan_claimed_until).getTime() < Date.now()) {
        throw new ConflictError('Scanner claim is missing, expired, or does not match this upload', 'UPLOAD_SCAN_CLAIM_INVALID');
      }

      if (input.verdict === 'error') {
        const terminal = current.scan_attempts >= MAX_SCAN_ATTEMPTS;
        const updated = (await client.query<UploadRow>(
          `UPDATE media_uploads
              SET state = CASE WHEN $2::boolean THEN 'scan_failed'::media_upload_state ELSE 'scan_pending'::media_upload_state END,
                  scan_claim_token = NULL, scan_claimed_until = NULL,
                  scan_last_error = $3, scan_provider = $4, scan_reference = $5,
                  scanned_at = CASE WHEN $2::boolean THEN CURRENT_TIMESTAMP ELSE scanned_at END,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING ${UPLOAD_SELECT_COLUMNS}`,
          [uploadId, terminal, input.errorMessage!, input.provider, input.reference ?? null],
        )).rows[0];
        await this.auditWith(client, terminal ? 'media_upload_scan_failed' : 'media_upload_scan_retry', null, updated, {
          scanAttempt: current.scan_attempts,
          provider: input.provider,
        });
        return updated;
      }

      if (input.verdict === 'clean') {
        this.assertAllowedMime(current.purpose, input.detectedMimeType!);
        if (input.detectedMimeType !== current.declared_mime_type) {
          objectToDelete = current.object_key;
          const rejected = (await client.query<UploadRow>(
            `UPDATE media_uploads
                SET state = 'rejected', detected_mime_type = $2, scanned_at = CURRENT_TIMESTAMP,
                    scan_provider = $3, scan_reference = $4,
                    scan_claim_token = NULL, scan_claimed_until = NULL,
                    scan_last_error = 'Detected MIME type does not match the declared MIME type',
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
              RETURNING ${UPLOAD_SELECT_COLUMNS}`,
            [uploadId, input.detectedMimeType, input.provider, input.reference ?? null],
          )).rows[0];
          await this.auditWith(client, 'media_upload_mime_rejected', null, rejected, {
            declaredMimeType: current.declared_mime_type,
            detectedMimeType: input.detectedMimeType,
          });
          return rejected;
        }
        const updated = (await client.query<UploadRow>(
          `UPDATE media_uploads
              SET state = 'clean', detected_mime_type = $2, content_sha256 = $3,
                  scanned_at = CURRENT_TIMESTAMP, scan_provider = $4, scan_reference = $5,
                  scan_claim_token = NULL, scan_claimed_until = NULL, scan_last_error = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING ${UPLOAD_SELECT_COLUMNS}`,
          [uploadId, input.detectedMimeType!, input.sha256!, input.provider, input.reference ?? null],
        )).rows[0];
        supersededObjects = await this.linkCleanAsset(client, updated);
        await this.auditWith(client, 'media_upload_scan_clean', null, updated, {
          provider: input.provider,
          detectedMimeType: input.detectedMimeType,
          sha256: input.sha256,
        });
        return updated;
      }

      objectToDelete = current.object_key;
      const updated = (await client.query<UploadRow>(
        `UPDATE media_uploads
            SET state = 'infected', scanned_at = CURRENT_TIMESTAMP,
                scan_provider = $2, scan_reference = $3,
                scan_claim_token = NULL, scan_claimed_until = NULL,
                scan_last_error = 'Malware scanner reported infected content',
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING ${UPLOAD_SELECT_COLUMNS}`,
        [uploadId, input.provider, input.reference ?? null],
      )).rows[0];
      await this.auditWith(client, 'media_upload_scan_infected', null, updated, { provider: input.provider });
      return updated;
    }, {}, this.db);

    if (objectToDelete) await this.storage.deleteObject(objectToDelete).catch(() => undefined);
    for (const key of supersededObjects) await this.storage.deleteObject(key).catch(() => undefined);
    return this.serialize(row);
  }

  private async linkCleanAsset(client: PoolClient, row: UploadRow): Promise<string[]> {
    const stablePath = `/api/v1/uploads/${row.id}/content`;
    if (row.purpose === 'profile_avatar') {
      await client.query(`UPDATE users SET avatar_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.owner_user_id, stablePath]);
      return this.markSuperseded(client, row, 'owner_user_id = $2', [row.owner_user_id]);
    }
    if (row.purpose === 'chama_logo') {
      await client.query(`UPDATE chamas SET logo_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.chama_id, stablePath]);
      return this.markSuperseded(client, row, 'chama_id = $2', [row.chama_id]);
    }
    return [];
  }

  private async markSuperseded(client: PoolClient, row: UploadRow, scopeSql: string, scopeValues: unknown[]) {
    const result = await client.query<{ object_key: string }>(
      `UPDATE media_uploads
          SET state = 'deleted', updated_at = CURRENT_TIMESTAMP
        WHERE purpose = $1::media_upload_purpose
          AND ${scopeSql}
          AND id <> $${scopeValues.length + 2}
          AND state = 'clean'
        RETURNING object_key`,
      [row.purpose, ...scopeValues, row.id],
    );
    return result.rows.map((item) => item.object_key);
  }

  private signedDownload(row: UploadRow, inline: boolean) {
    if (row.state !== 'clean') {
      throw new ConflictError('File is not available until malware scanning completes successfully', 'UPLOAD_NOT_CLEAN');
    }
    const signed = this.storage.createDownloadUrl(row.object_key, row.original_filename, {
      inline,
      expiresSeconds: env.DOWNLOAD_SIGNED_URL_TTL_SECONDS,
    });
    return {
      upload: this.serialize(row),
      downloadUrl: signed.url,
      expiresAt: signed.expiresAt,
    };
  }

  private async assertCreateAuthorization(actorId: string, input: CreateUploadInput) {
    const user = await this.db.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [actorId]);
    if (!user.rowCount) throw new ForbiddenError('Active account required for uploads', 'UPLOAD_ACCOUNT_INACTIVE');
    if (input.purpose === 'profile_avatar') return;
    if (input.purpose === 'chama_logo') {
      const membership = await this.db.query(
        `SELECT 1 FROM chama_members
          WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'
            AND role IN ('chairperson','secretary')`,
        [input.chamaId, actorId],
      );
      if (!membership.rowCount) throw new ForbiddenError('Only an active Chairperson or Secretary may upload a Chama logo', 'UPLOAD_CHAMA_LOGO_FORBIDDEN');
      return;
    }
    const ticket = await this.loadTicket(input.ticketId!);
    await this.assertTicketAccess(actorId, ticket);
  }

  private async assertCanAccess(actorId: string | null, row: UploadRow, allowPublicChamaLogo: boolean) {
    if (row.state === 'deleted') throw new NotFoundError('Upload not found', 'UPLOAD_NOT_FOUND');
    if (row.purpose === 'profile_avatar') {
      if (!actorId) throw new ForbiddenError('Authentication is required for profile media', 'UPLOAD_ACCESS_FORBIDDEN');
      if (actorId === row.owner_user_id || await this.isPlatformAdmin(actorId)) return;
      const shared = await this.db.query(
        `SELECT 1
           FROM chama_members mine
           JOIN chama_members theirs ON theirs.chama_id = mine.chama_id
          WHERE mine.user_id = $1 AND theirs.user_id = $2
            AND mine.membership_status = 'active' AND theirs.membership_status = 'active'
          LIMIT 1`,
        [actorId, row.owner_user_id],
      );
      if (shared.rowCount) return;
      throw new ForbiddenError('Profile media is visible only within shared Chama context', 'UPLOAD_ACCESS_FORBIDDEN');
    }
    if (row.purpose === 'chama_logo') {
      const chama = (await this.db.query<{ visibility: string; status: string }>(
        `SELECT visibility::text AS visibility, status::text AS status FROM chamas WHERE id = $1`,
        [row.chama_id],
      )).rows[0];
      if (!chama) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');
      if (allowPublicChamaLogo && ['public', 'application'].includes(chama.visibility) && ['recruiting', 'active', 'completed'].includes(chama.status)) return;
      if (actorId && await this.isPlatformAdmin(actorId)) return;
      if (actorId) {
        const membership = await this.db.query(
          `SELECT 1 FROM chama_members WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
          [row.chama_id, actorId],
        );
        if (membership.rowCount) return;
      }
      throw new ForbiddenError('Chama logo access denied', 'UPLOAD_ACCESS_FORBIDDEN');
    }
    if (!actorId) throw new ForbiddenError('Authentication is required for support attachments', 'UPLOAD_ACCESS_FORBIDDEN');
    const ticket = await this.loadTicket(row.support_ticket_id!);
    await this.assertTicketAccess(actorId, ticket);
  }

  private async assertTicketAccess(actorId: string, ticket: TicketAccessRow) {
    if (ticket.user_id === actorId || ticket.assigned_to === actorId) return;
    if (await this.isPlatformAdmin(actorId)) return;
    if (ticket.routing_target === 'chama_chair' && ticket.chama_id) {
      const chair = await this.db.query(
        `SELECT 1 FROM chama_members
          WHERE chama_id = $1 AND user_id = $2 AND role = 'chairperson' AND membership_status = 'active'`,
        [ticket.chama_id, actorId],
      );
      if (chair.rowCount) return;
    }
    throw new ForbiddenError('Support attachment access denied', 'UPLOAD_TICKET_FORBIDDEN');
  }

  private async loadTicket(ticketId: string) {
    const row = (await this.db.query<TicketAccessRow>(
      `SELECT id, user_id, chama_id, routing_target, assigned_to FROM support_tickets WHERE id = $1`,
      [ticketId],
    )).rows[0];
    if (!row) throw new NotFoundError('Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
    return row;
  }

  private async isPlatformAdmin(userId: string) {
    return Boolean((await this.db.query(
      `SELECT 1 FROM users WHERE id = $1 AND is_platform_admin = TRUE AND status = 'active'`,
      [userId],
    )).rowCount);
  }

  private async load(id: string) { return this.loadWith(this.db, id, false); }

  private async loadWith(db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, id: string, forUpdate: boolean) {
    const row = (await db.query<UploadRow>(
      `SELECT ${UPLOAD_SELECT_COLUMNS} FROM media_uploads WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    )).rows[0];
    if (!row) throw new NotFoundError('Upload not found', 'UPLOAD_NOT_FOUND');
    return row;
  }

  private assertAllowedMime(purpose: MediaUploadPurpose, mimeType: string) {
    const set = purpose === 'support_ticket_attachment' ? ATTACHMENT_MIME_TYPES : IMAGE_MIME_TYPES;
    if (!set.has(mimeType)) throw new BadRequestError('File type is not allowed for this upload purpose', undefined, 'UPLOAD_MIME_FORBIDDEN');
  }

  private async rejectUpload(row: UploadRow, reason: string) {
    await this.db.query(
      `UPDATE media_uploads SET state = 'rejected', scan_last_error = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND state = 'initiated'`,
      [row.id, reason.slice(0, 1000)],
    );
    await this.audit('media_upload_rejected', row.owner_user_id, row, { reason: reason.slice(0, 500) });
  }

  private async audit(action: string, actorId: string | null, row: UploadRow, payload: Record<string, unknown>) {
    await this.db.query(
      `INSERT INTO audit_logs (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
       VALUES ('system',$1,$2,$3::audit_actor_role,$4,'media_upload',$5,$6::jsonb)`,
      [action, actorId, actorId ? 'member' : 'system', row.chama_id, row.id, JSON.stringify(payload)],
    );
  }

  private async auditWith(client: PoolClient, action: string, actorId: string | null, row: UploadRow, payload: Record<string, unknown>) {
    await client.query(
      `INSERT INTO audit_logs (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
       VALUES ('system',$1,$2,$3::audit_actor_role,$4,'media_upload',$5,$6::jsonb)`,
      [action, actorId, actorId ? 'member' : 'system', row.chama_id, row.id, JSON.stringify(payload)],
    );
  }

  private serialize(row: UploadRow) {
    return {
      id: row.id,
      purpose: row.purpose,
      chamaId: row.chama_id,
      supportTicketId: row.support_ticket_id,
      fileName: row.original_filename,
      declaredMimeType: row.declared_mime_type,
      detectedMimeType: row.detected_mime_type,
      sizeBytes: Number(row.size_bytes),
      objectSizeBytes: row.object_size_bytes === null ? null : Number(row.object_size_bytes),
      state: row.state,
      uploadExpiresAt: row.upload_expires_at,
      uploadedAt: row.uploaded_at,
      scanRequestedAt: row.scan_requested_at,
      scanAttempts: row.scan_attempts,
      scannedAt: row.scanned_at,
      scanProvider: row.scan_provider,
      scanReference: row.scan_reference,
      sha256: row.content_sha256,
      scanError: row.scan_last_error,
      contentPath: row.state === 'clean' ? `/api/v1/uploads/${row.id}/content` : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

const UPLOAD_SELECT_COLUMNS = `id, owner_user_id, purpose::text AS purpose, chama_id, support_ticket_id,
  original_filename, object_key, declared_mime_type, detected_mime_type, size_bytes::text,
  object_size_bytes::text, object_etag, state::text AS state, upload_expires_at::text,
  uploaded_at::text, scan_requested_at::text, scan_claim_token, scan_claimed_until::text,
  scan_attempts, scanned_at::text, scan_provider, scan_reference, content_sha256,
  scan_last_error, created_at::text, updated_at::text`;

function sanitizeFileName(value: string) {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? 'upload';
  const safe = base.replace(/[\x00-\x1F\x7F]/g, '').replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  if (!safe || safe === '.' || safe === '..') return 'upload';
  return safe.slice(0, 180);
}

function normalizeMime(value: string | null) {
  if (!value) return null;
  return value.split(';', 1)[0].trim().toLowerCase();
}

export const uploadService = new UploadService();
