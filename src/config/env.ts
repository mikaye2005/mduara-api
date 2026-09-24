import 'dotenv/config';
import { z } from 'zod';

function optionalEnv<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    schema.optional(),
  );
}

export function resolveDatabaseUrl(env: {
  DATABASE_URL?: string | undefined;
  DB_HOST?: string;
  DB_PORT?: string | number;
  DB_USER?: string;
  DB_PASSWORD?: string;
  DB_NAME?: string;
}) {
  const configuredDatabaseUrl = env.DATABASE_URL?.trim();
  if (configuredDatabaseUrl) return configuredDatabaseUrl;

  const host = env.DB_HOST ?? 'localhost';
  const port = env.DB_PORT ?? 5432;
  const user = env.DB_USER ?? 'postgres';
  const password = env.DB_PASSWORD ?? 'postgres';
  const name = env.DB_NAME ?? 'mduara';

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: optionalEnv(z.string()),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('postgres'),
  DB_NAME: z.string().default('mduara'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_POOL_MAX: optionalEnv(z.coerce.number().int().positive()),

  JWT_SECRET: optionalEnv(z.string().min(32)),
  JWT_ACCESS_SECRET: optionalEnv(z.string().min(32)),
  JWT_REFRESH_SECRET: optionalEnv(z.string().min(32)),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(5),
  OTP_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(3),
  OTP_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  SMS_PROVIDER: z.enum(['africastalking', 'console']).default('console'),
  AFRICASTALKING_USERNAME: optionalEnv(z.string()),
  AFRICASTALKING_API_KEY: optionalEnv(z.string()),
  AFRICASTALKING_SENDER_ID: optionalEnv(z.string()),
  AFRICASTALKING_BASE_URL: optionalEnv(z.string()),

  EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  EMAIL_FROM: optionalEnv(z.string().email()),
  SMTP_HOST: optionalEnv(z.string()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMTP_USER: optionalEnv(z.string()),
  SMTP_PASSWORD: optionalEnv(z.string()),

  PUSH_PROVIDER: z.enum(['console', 'webhook']).default('console'),
  PUSH_WEBHOOK_URL: optionalEnv(z.string().url()),
  PUSH_WEBHOOK_SECRET: optionalEnv(z.string().min(16)),
  NOTIFICATION_DISPATCH_SECRET: optionalEnv(z.string().min(32)),

  OBJECT_STORAGE_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OBJECT_STORAGE_ENDPOINT: optionalEnv(z.string().url()),
  OBJECT_STORAGE_REGION: z.string().trim().min(1).default('us-east-1'),
  OBJECT_STORAGE_BUCKET: optionalEnv(z.string().trim().min(3)),
  OBJECT_STORAGE_ACCESS_KEY_ID: optionalEnv(z.string().trim().min(3)),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: optionalEnv(z.string().min(8)),
  OBJECT_STORAGE_SESSION_TOKEN: optionalEnv(z.string()),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  UPLOAD_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  DOWNLOAD_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  MALWARE_SCAN_SECRET: optionalEnv(z.string().min(32)),

  SCHEDULER_TIMEZONE: z.string().default('Africa/Nairobi').refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'Invalid IANA timezone'),
  WORKER_DB_POOL_MAX: z.coerce.number().int().min(1).max(10).default(2),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  REMINDER_CHANNELS: z.enum(['sms', 'email', 'sms,email']).default('sms,email'),

  FRONTEND_URL: optionalEnv(z.string()),
  CHAMA_MAX_MEMBERS: z.coerce.number().int().positive().default(500),

  MPESA_CONSUMER_KEY: optionalEnv(z.string()),
  MPESA_CONSUMER_SECRET: optionalEnv(z.string()),
  MPESA_SHORTCODE: optionalEnv(z.string()),
  MPESA_PASSKEY: optionalEnv(z.string()),
  MPESA_CALLBACK_URL: optionalEnv(z.string()),
  MPESA_SUBSCRIPTION_CALLBACK_URL: optionalEnv(z.string().url()),
  MPESA_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_STK_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  MPESA_CALLBACK_ALLOWED_IPS: optionalEnv(z.string()),
  MPESA_WEBHOOK_HMAC_SECRET: optionalEnv(z.string().min(32)),
  MPESA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  MPESA_B2C_INITIATOR_NAME: z.string().optional(),
  MPESA_B2C_SECURITY_CREDENTIAL: z.string().optional(),
  MPESA_B2C_RESULT_URL: optionalEnv(z.string().url()),
  MPESA_B2C_TIMEOUT_URL: optionalEnv(z.string().url()),
  MPESA_MGR_B2C_RESULT_URL: optionalEnv(z.string().url()),
  MPESA_MGR_B2C_TIMEOUT_URL: optionalEnv(z.string().url()),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }

  const databaseUrl = resolveDatabaseUrl(parsed.data);

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
