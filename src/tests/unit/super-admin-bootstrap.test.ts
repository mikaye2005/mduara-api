import assert from 'node:assert/strict';
import test from 'node:test';
import { readSuperAdminBootstrapConfig } from '../../db/bootstrap-super-admin';

const validEnvironment = {
  SUPER_ADMIN_FULL_NAME: 'M-Duara Platform Admin',
  SUPER_ADMIN_EMAIL: 'admin@mduara.test',
  SUPER_ADMIN_PHONE: '+254712345678',
  SUPER_ADMIN_PASSWORD: 'DevelopmentPassword123!',
  BCRYPT_SALT_ROUNDS: '12',
};

test('super admin bootstrap requires an explicit identity and password', () => {
  assert.throws(
    () => readSuperAdminBootstrapConfig({ ...validEnvironment, SUPER_ADMIN_PASSWORD: '' }),
    /SUPER_ADMIN_PASSWORD/,
  );
});

test('super admin bootstrap uses the registration identity contract', () => {
  assert.throws(
    () => readSuperAdminBootstrapConfig({ ...validEnvironment, SUPER_ADMIN_PHONE: '0712345678' }),
    /E\.164/,
  );

  assert.deepEqual(readSuperAdminBootstrapConfig(validEnvironment), {
    fullName: 'M-Duara Platform Admin',
    email: 'admin@mduara.test',
    phone: '+254712345678',
    pin: 'DevelopmentPassword123!',
    bcryptSaltRounds: 12,
  });
});