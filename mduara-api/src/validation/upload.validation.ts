import { z } from 'zod';


export const uploadPurposeSchema = z.enum(['profile_avatar', 'chama_logo', 'support_ticket_attachment']);
const supportedMimeTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);


export const createUploadSchema = z.object({
  purpose: uploadPurposeSchema,
  fileName: z.string().trim().min(1).max(255),
  mimeType: supportedMimeTypeSchema,
  sizeBytes: z.coerce.number().int().positive().max(10 * 1024 * 1024),
  chamaId: z.string().uuid().optional(),
  ticketId: z.string().uuid().optional(),
}).strict().superRefine((value, ctx) => {
  const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType);
  if (value.purpose !== 'support_ticket_attachment' && !isImage) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mimeType'], message: 'Profile avatars and Chama logos must be JPEG, PNG, or WebP' });
  }
  if (value.purpose !== 'support_ticket_attachment' && value.sizeBytes > 5 * 1024 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sizeBytes'], message: 'Profile avatars and Chama logos are limited to 5 MiB' });
  }
  if (value.purpose === 'profile_avatar' && (value.chamaId || value.ticketId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purpose'], message: 'profile_avatar cannot specify chamaId or ticketId' });
  }
  if (value.purpose === 'chama_logo' && (!value.chamaId || value.ticketId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chamaId'], message: 'chama_logo requires chamaId and cannot specify ticketId' });
  }
  if (value.purpose === 'support_ticket_attachment') {
    if (!value.ticketId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketId'], message: 'support_ticket_attachment requires ticketId' });
    }
    if (value.chamaId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chamaId'], message: 'support_ticket_attachment derives Chama scope from ticketId and cannot specify chamaId' });
    }
  }
});


export const uploadIdSchema = z.string().uuid();
export const uploadDownloadQuerySchema = z.object({
  disposition: z.enum(['inline', 'attachment']).default('inline'),
}).strict();


export const scanClaimSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).strict();


export const scanResultSchema = z.object({
  claimToken: z.string().uuid(),
  verdict: z.enum(['clean', 'infected', 'error']),
  provider: z.string().trim().min(1).max(120),
  reference: z.string().trim().max(255).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform((value) => value.toLowerCase()).optional(),
  detectedMimeType: supportedMimeTypeSchema.optional(),
  errorMessage: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === 'clean') {
    if (!value.sha256) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sha256'], message: 'sha256 is required for a clean scan' });
    if (!value.detectedMimeType) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['detectedMimeType'], message: 'detectedMimeType is required for a clean scan' });
  }
  if (value.verdict === 'error' && !value.errorMessage) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorMessage'], message: 'errorMessage is required when the scanner reports an error' });
  }
});


export type CreateUploadInput = z.infer<typeof createUploadSchema>;
export type ScanResultInput = z.infer<typeof scanResultSchema>;