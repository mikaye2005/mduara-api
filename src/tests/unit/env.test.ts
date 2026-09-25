import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnv, resolveDatabaseUrl } from '../../config/env';

const validBase = { JWT_SECRET: 'test-only-jwt-secret-never-use-in-production' };

test('blank optional settings behave as unset and retain configured fallbacks', () => {
  const config = loadEnv({
    ...validBase,
    DATABASE_URL: ' ',
    DATABASE_POOL_MAX: '',
    DB_USER: 'local-user',
    DB_PASSWORD: 'local-password',
    DB_NAME: 'local-db',
    DB_POOL_MAX: '4',
    JWT_ACCESS_SECRET: '',
    JWT_REFRESH_SECRET: '\t',
    MPESA_WEBHOOK_HMAC_SECRET: '',
    MPESA_SUBSCRIPTION_CALLBACK_URL: '',
    MPESA_B2C_RESULT_URL: '',
    MPESA_B2C_TIMEOUT_URL: '',
    MPESA_MGR_B2C_RESULT_URL: '',
    MPESA_MGR_B2C_TIMEOUT_URL: '',
    EMAIL_FROM: '',
    PUSH_WEBHOOK_URL: '',
    PUSH_WEBHOOK_SECRET: '',
    NOTIFICATION_DISPATCH_SECRET: '',
    OBJECT_STORAGE_ENDPOINT: '',
    OBJECT_STORAGE_BUCKET: '',
    OBJECT_STORAGE_ACCESS_KEY_ID: '',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    MALWARE_SCAN_SECRET: '',
  });

  assert.equal(config.DATABASE_URL, 'postgres://local-user:local-password@localhost:5432/local-db');
  assert.equal(config.DATABASE_POOL_MAX, 4);
  assert.equal(config.JWT_ACCESS_SECRET, `${validBase.JWT_SECRET}:access`);
  assert.equal(config.JWT_REFRESH_SECRET, `${validBase.JWT_SECRET}:refresh`);
  assert.equal(config.MPESA_WEBHOOK_HMAC_SECRET, undefined);
  assert.equal(config.EMAIL_FROM, undefined);
  assert.equal(config.OBJECT_STORAGE_ENDPOINT, undefined);
});

test('nonblank optional settings still validate without altering secret bytes', () => {
  const secret = '  test-only-webhook-secret-32-characters  ';
  assert.equal(loadEnv({ ...validBase, MPESA_WEBHOOK_HMAC_SECRET: secret }).MPESA_WEBHOOK_HMAC_SECRET, secret);

  for (const [key, value] of [
    ['MPESA_WEBHOOK_HMAC_SECRET', 'too-short'],
    ['JWT_ACCESS_SECRET', 'too-short'],
    ['PUSH_WEBHOOK_URL', 'not-a-url'],
    ['EMAIL_FROM', 'not-an-email'],
    ['DATABASE_POOL_MAX', '0'],
  ]) {
    assert.throws(() => loadEnv({ ...validBase, [key]: value }), new RegExp(key));
  }
});

test('blank values do not bypass required or enabled-provider configuration', () => {
  assert.throws(() => loadEnv({ JWT_SECRET: '', JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '' }), /Set JWT_SECRET/);
  assert.throws(() => loadEnv({ ...validBase, PORT: '' }), /PORT/);
  assert.throws(() => loadEnv({ ...validBase, SMS_PROVIDER: 'africastalking', AFRICASTALKING_USERNAME: ' ', AFRICASTALKING_API_KEY: '' }), /required when SMS_PROVIDER/);
  assert.throws(() => loadEnv({ ...validBase, EMAIL_PROVIDER: 'smtp', SMTP_HOST: '', EMAIL_FROM: '' }), /required when EMAIL_PROVIDER/);
  assert.throws(() => loadEnv({ ...validBase, SMTP_USER: 'mailer', SMTP_PASSWORD: ' ' }), /SMTP_PASSWORD is required/);
  assert.throws(() => loadEnv({ ...validBase, PUSH_PROVIDER: 'webhook', PUSH_WEBHOOK_URL: '' }), /PUSH_WEBHOOK_URL is required/);
  assert.throws(() => loadEnv({ ...validBase, OBJECT_STORAGE_ENABLED: 'true', OBJECT_STORAGE_ENDPOINT: '' }), /File uploads are enabled but these settings are missing/);
});

test('database URL resolver builds from DB_* values when DATABASE_URL is unset', () => {
  const url = resolveDatabaseUrl({
    DATABASE_URL: '',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'local-user',
    DB_PASSWORD: 'local-password',
    DB_NAME: 'local-db',
  });

  assert.equal(url, 'postgres://local-user:local-password@localhost:5432/local-db');
});

test('development console payments are explicit and forbidden in production', () => {
  assert.equal(loadEnv({ ...validBase, MPESA_PROVIDER: 'console' }).MPESA_PROVIDER, 'console');
  assert.throws(
    () => loadEnv({ ...validBase, NODE_ENV: 'production', MPESA_PROVIDER: 'console' }),
    /development-only/,
  );
  assert.equal(
    loadEnv({ ...validBase, NODE_ENV: 'production', MPESA_PROVIDER: 'daraja' }).MPESA_PROVIDER,
    'daraja',
  );
});
