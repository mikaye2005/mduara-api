import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';
import { uploadService } from '../services/upload.service';
import { UnauthorizedError, ServiceUnavailableError } from '../utils/errors';
import { createUploadSchema, scanClaimSchema, scanResultSchema, uploadDownloadQuerySchema, uploadIdSchema } from '../validation/upload.validation';

export async function createUpload(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = createUploadSchema.parse(req.body);
    const result = await uploadService.createUpload(req.user.id, input);
    res.status(201).json({ data: result });
  } catch (error) { next(error); }
}

export async function completeUpload(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const id = uploadIdSchema.parse(req.params.id);
    res.json({ data: await uploadService.completeUpload(req.user.id, id) });
  } catch (error) { next(error); }
}

export async function getUpload(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const id = uploadIdSchema.parse(req.params.id);
    res.json({ data: await uploadService.getUpload(req.user.id, id) });
  } catch (error) { next(error); }
}

export async function getDownload(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const id = uploadIdSchema.parse(req.params.id);
    const query = uploadDownloadQuerySchema.parse(req.query);
    res.json({ data: await uploadService.createDownload(req.user.id, id, query.disposition === 'inline') });
  } catch (error) { next(error); }
}

export async function contentRedirect(req: Request, res: Response, next: NextFunction) {
  try {
    const id = uploadIdSchema.parse(req.params.id);
    const result = await uploadService.createContentRedirect(req.user?.id ?? null, id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(302, result.downloadUrl);
  } catch (error) { next(error); }
}

export async function claimScans(req: Request, res: Response, next: NextFunction) {
  try {
    requireScannerSecret(req);
    const input = scanClaimSchema.parse(req.body ?? {});
    res.json({ data: await uploadService.claimScans(input.limit) });
  } catch (error) { next(error); }
}

export async function scanResult(req: Request, res: Response, next: NextFunction) {
  try {
    requireScannerSecret(req);
    const id = uploadIdSchema.parse(req.params.id);
    const input = scanResultSchema.parse(req.body);
    res.json({ data: await uploadService.recordScanResult(id, input) });
  } catch (error) { next(error); }
}

function requireScannerSecret(req: Request) {
  const expected = env.MALWARE_SCAN_SECRET;
  if (!expected) throw new ServiceUnavailableError('Malware scanner integration is not configured', 'MALWARE_SCANNER_DISABLED');
  const supplied = req.header('x-mduara-scan-secret') ?? '';
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedError('Invalid malware scanner credential', 'MALWARE_SCANNER_UNAUTHORIZED');
}

export default { createUpload, completeUpload, getUpload, getDownload, contentRedirect, claimScans, scanResult };
