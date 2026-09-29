import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  // Kenyan mobile numbers may be entered as 0712345678/0112345678. Persist
  // and authenticate them in one canonical E.164 form.
  .regex(/^(?:\+254|0)[17]\d{8}$/, 'Enter a Kenyan mobile number, e.g. 0712345678 or +254712345678')
  .transform((value) => value.startsWith('0') ? `+254${value.slice(1)}` : value);

const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'Verification code must be numeric');

const passwordSchema = z
  .string()
  .trim()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

const identifierSchema = z.string().trim().min(1, 'Phone or email is required');

export const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: phoneSchema,
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: passwordSchema,
});

// Phone + PIN is the product-facing contract. Keep the former
// identifier/password shape as a compatibility path for existing clients.
export const loginSchema = z.object({
  phone: phoneSchema.optional(),
  pin: passwordSchema.optional(),
  identifier: identifierSchema.optional(),
  password: passwordSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.phone && !value.identifier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Phone number is required' });
  }
  if (!value.pin && !value.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pin'], message: 'PIN is required' });
  }
  if (value.pin && value.password && value.pin !== value.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pin'], message: 'Provide either pin or password, not conflicting values' });
  }
}).transform((value) => ({
  identifier: value.phone ?? (value.identifier!.match(/^0[17]\d{8}$/) ? `+254${value.identifier!.slice(1)}` : value.identifier!),
  password: value.pin ?? value.password!,
}));

export const sendOtpSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(['registration', 'password_reset']),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });

export const resetPasswordSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
