import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone number must be in E.164 format, e.g. +254712345678');

const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,8}$/, 'Verification code must be numeric');

const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits');

export const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: phoneSchema,
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  pin: pinSchema,
});

export const loginSchema = z.object({
  phone: phoneSchema,
  pin: pinSchema,
});

export const sendOtpSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(['registration', 'pin_reset']),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const changePinSchema = z
  .object({
    currentPin: pinSchema,
    newPin: pinSchema,
  })
  .refine((value) => value.currentPin !== value.newPin, {
    message: 'New PIN must be different from the current PIN',
    path: ['newPin'],
  });

export const resetPinSchema = z.object({
  phone: phoneSchema,
  code: otpCodeSchema,
  newPin: pinSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type ChangePinInput = z.infer<typeof changePinSchema>;
export type ResetPinInput = z.infer<typeof resetPinSchema>;
