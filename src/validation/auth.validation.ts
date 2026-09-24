import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone number must be in E.164 format, e.g. +254712345678');

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

export const loginSchema = z.object({
  identifier: identifierSchema,
  password: passwordSchema,
});

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
