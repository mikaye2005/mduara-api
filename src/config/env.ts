import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_NAME: z.string().default('mduara'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().optional(),

  JWT_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  SUPER_ADMIN_BOOTSTRAP: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SUPER_ADMIN_FULL_NAME: z.string().trim().min(2).optional(),
  SUPER_ADMIN_EMAIL: z.string().trim().email().optional(),
  SUPER_ADMIN_PHONE: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).optional(),
  SUPER_ADMIN_PIN: z.string().trim().regex(/^\d{4,6}$/).optional(),
  AUTH_DEV_EMAIL: z.string().trim().email().optional(),
  AUTH_DEV_PHONE: z.string().trim().regex(/^\+[1-9]\d{7,14}$/).optional(),
  AUTH_DEV_PIN: z.string().trim().regex(/^\d{4,6}$/).optional(),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(3),
  OTP_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  PIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  PIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  SMS_PROVIDER: z.enum(['africastalking', 'console']).default('console'),
  AFRICASTALKING_USERNAME: z.string().optional(),
  AFRICASTALKING_API_KEY: z.string().optional(),
  AFRICASTALKING_SENDER_ID: z.string().optional(),
  AFRICASTALKING_BASE_URL: z.string().optional(),

  EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  EMAIL_FROM: z.string().email().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  PUSH_PROVIDER: z.enum(['console', 'webhook']).default('console'),
  PUSH_WEBHOOK_URL: z.string().url().optional(),
  PUSH_WEBHOOK_SECRET: z.string().min(16).optional(),
  NOTIFICATION_DISPATCH_SECRET: z.string().min(32).optional(),

  OBJECT_STORAGE_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().trim().min(1).default('us-east-1'),
  OBJECT_STORAGE_BUCKET: z.string().trim().min(3).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().trim().min(3).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(8).optional(),
  OBJECT_STORAGE_SESSION_TOKEN: z.string().optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  UPLOAD_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  DOWNLOAD_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  MALWARE_SCAN_SECRET: z.string().min(32).optional(),

  SCHEDULER_TIMEZONE: z.string().default('Africa/Nairobi').refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid IANA timezone'),
  WORKER_DB_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  REMINDER_CHANNELS: z.enum(['sms', 'email', 'sms,email']).default('sms,email'),

  FRONTEND_URL: z.string().optional(),
  CHAMA_MAX_MEMBERS: z.coerce.number().int().positive().default(500),

  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_CALLBACK_URL: z.string().optional(),
  MPESA_SUBSCRIPTION_CALLBACK_URL: z.string().url().optional(),
  MPESA_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_STK_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  MPESA_CALLBACK_ALLOWED_IPS: z.string().optional(),
  MPESA_WEBHOOK_HMAC_SECRET: z.string().min(32).optional(),
  MPESA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  MPESA_B2C_INITIATOR_NAME: z.string().optional(),
  MPESA_B2C_SECURITY_CREDENTIAL: z.string().optional(),
  MPESA_B2C_RESULT_URL: z.string().url().optional(),
  MPESA_B2C_TIMEOUT_URL: z.string().url().optional(),
  MPESA_MGR_B2C_RESULT_URL: z.string().url().optional(),
  MPESA_MGR_B2C_TIMEOUT_URL: z.string().url().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }

  const databaseUrl =
    parsed.data.DATABASE_URL ??
    `postgres://${encodeURIComponent(parsed.data.DB_USER)}:${encodeURIComponent(parsed.data.DB_PASSWORD)}@${parsed.data.DB_HOST}:${parsed.data.DB_PORT}/${parsed.data.DB_NAME}`;

  const jwtBase = parsed.data.JWT_SECRET;
  const jwtAccessSecret = parsed.data.JWT_ACCESS_SECRET ?? (jwtBase ? `${jwtBase}:access` : undefined);
  const jwtRefreshSecret = parsed.data.JWT_REFRESH_SECRET ?? (jwtBase ? `${jwtBase}:refresh` : undefined);

  if (!jwtAccessSecret || !jwtRefreshSecret) {
    throw new Error('Set JWT_SECRET or both JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (minimum 32 characters).');
  }

  if (parsed.data.SMS_PROVIDER === 'africastalking') {
    if (!parsed.data.AFRICASTALKING_USERNAME || !parsed.data.AFRICASTALKING_API_KEY) {
      throw new Error('AFRICASTALKING_USERNAME and AFRICASTALKING_API_KEY are required when SMS_PROVIDER=africastalking');
    }
  }

  if (parsed.data.EMAIL_PROVIDER === 'smtp' && (!parsed.data.SMTP_HOST || !parsed.data.EMAIL_FROM)) {
    throw new Error('SMTP_HOST and EMAIL_FROM are required when EMAIL_PROVIDER=smtp');
  }
  if (parsed.data.SMTP_USER && !parsed.data.SMTP_PASSWORD) {
    throw new Error('SMTP_PASSWORD is required when SMTP_USER is set');
  }
  if (parsed.data.PUSH_PROVIDER === 'webhook' && !parsed.data.PUSH_WEBHOOK_URL) {
    throw new Error('PUSH_WEBHOOK_URL is required when PUSH_PROVIDER=webhook');
  }
  if (parsed.data.OBJECT_STORAGE_ENABLED) {
    const requiredStorage = [
      ['OBJECT_STORAGE_ENDPOINT', parsed.data.OBJECT_STORAGE_ENDPOINT],
      ['OBJECT_STORAGE_BUCKET', parsed.data.OBJECT_STORAGE_BUCKET],
      ['OBJECT_STORAGE_ACCESS_KEY_ID', parsed.data.OBJECT_STORAGE_ACCESS_KEY_ID],
      ['OBJECT_STORAGE_SECRET_ACCESS_KEY', parsed.data.OBJECT_STORAGE_SECRET_ACCESS_KEY],
      ['MALWARE_SCAN_SECRET', parsed.data.MALWARE_SCAN_SECRET],
    ] as const;
    const missing = requiredStorage.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`File uploads are enabled but these settings are missing: ${missing.join(', ')}`);
  }

  return {
    ...parsed.data,
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: parsed.data.DATABASE_POOL_MAX ?? parsed.data.DB_POOL_MAX,
    JWT_ACCESS_SECRET: jwtAccessSecret,
    JWT_REFRESH_SECRET: jwtRefreshSecret,
    CHAMA_MAX_MEMBERS: parsed.data.CHAMA_MAX_MEMBERS,
  };
}

export const env = loadEnv();
export type Env = typeof env;
