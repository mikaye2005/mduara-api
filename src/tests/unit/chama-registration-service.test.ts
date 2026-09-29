import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { ChamaRegistrationService } from '../../services/chama-registration.service';
import type { StkPushGateway } from '../../services/payment.service';

test('development deferred Chama creation skips STK, creates the Chama, and audits the bypass', async () => {
  const statements: string[] = [];
  const queryParameters: unknown[][] = [];
  let gatewayCalled = false;
  const client = {
    async query(sql: string, parameters?: unknown[]) {
      statements.push(sql);
      queryParameters.push(parameters ?? []);
      if (sql.includes('INSERT INTO chamas')) {
        return { rows: [{ id: 'chama-123', public_join_code: 'MD12345678' }] };
      }
      if (sql.includes('INSERT INTO audit_logs')) return { rows: [{ id: 'audit-123' }] };
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const database = { connect: async () => client } as unknown as Pool;
  const gateway: StkPushGateway = {
    async initiate() {
      gatewayCalled = true;
      throw new Error('STK must not be called for deferred development creation');
    },
  };
  const service = new ChamaRegistrationService(database, gateway, 'development');

  const result = await service.initiate({
    actorId: 'founder-123',
    actorRole: 'member',
    founderId: 'founder-123',
    phoneNumber: '0712345678',
    setupPaymentMode: 'deferred',
    creation: {
      name: 'Test Chama',
      type: 'goal_based',
      contribution_amount: 500,
      contribution_frequency: 'monthly',
      created_by: 'founder-123',
    },
  });

  assert.equal(gatewayCalled, false);
  assert.equal(result.status, 'bypassed');
  assert.equal(result.chamaId, 'chama-123');
  assert.equal(result.paymentId, null);
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO chama_members')));
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO chama_rules')));
  assert.ok(queryParameters.some((parameters) => parameters.includes('chama_registration_payment_bypassed')));
});