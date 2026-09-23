import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { TrustScoreService } from '../../services/trust-score.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-32 trust score is governed, private, append-only and version-traceable', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `trust_score_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  await migrate({
    databaseUrl: databaseUrl!,
    dir: 'migrations',
    direction: 'up',
    schema,
    createSchema: true,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql',
    singleTransaction: true,
    log: () => {},
  });

  const ownerId = '30000000-0000-4000-8000-000000000041';
  const otherId = '30000000-0000-4000-8000-000000000042';
  await pool.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified, is_platform_admin)
     VALUES
       ($1, 'trust-owner@example.test', 'pin', 'Trust Owner', '+254700000041', 'active', TRUE, TRUE),
       ($2, 'other-trust@example.test', 'pin', 'Other User', '+254700000042', 'active', TRUE, FALSE)`,
    [ownerId, otherId],
  );

  const chamaId = (await pool.query<{ id: string }>(
    `INSERT INTO chamas
       (name, type, status, visibility, goal_code, contribution_amount, contribution_frequency, currency)
     VALUES ('Trust Test Chama', 'goal_based', 'active', 'public', 'washing_machine', 5000, 'monthly', 'KES')
     RETURNING id`,
  )).rows[0].id;
  const membershipId = (await pool.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id, user_id, membership_status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [chamaId, ownerId],
  )).rows[0].id;

  const service = new TrustScoreService(pool);

  // Canonical migration deliberately has no active production formula.
  assert.equal(Number((await pool.query(`SELECT COUNT(*) FROM trust_score_formula_versions`)).rows[0].count), 0);
  const unavailableMember = await service.getOwnMembershipTrust(membershipId, ownerId);
  assert.equal(unavailableMember.available, false);
  assert.equal(unavailableMember.score, null);
  assert.equal(unavailableMember.unavailableReason, 'TRUST_SCORE_FORMULA_NOT_ACTIVATED');
  const unavailableChama = await service.getPublicChamaTrust(chamaId);
  assert.equal(unavailableChama.available, false);

  await assert.rejects(
    pool.query(
      `INSERT INTO trust_score_formula_versions
         (subject_type, version, status, public_description, inputs, weights, levels,
          definition_hash, created_by, approved_by, approved_at, activated_at)
       VALUES ('member', 'invalid-empty-active', 'active', 'Invalid', '[]', '{}', '[]',
               $1, $2, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ['0'.repeat(64), ownerId],
    ),
    /chk_trust_formula_documented_definition|check constraint/i,
  );

  const memberFormulaId = '60000000-0000-4000-8000-000000000001';
  const chamaFormulaId = '60000000-0000-4000-8000-000000000002';
  await pool.query(
    `INSERT INTO trust_score_formula_versions
       (id, subject_type, version, status, public_description, inputs, weights, levels,
        definition_hash, created_by, approved_by, approved_at, activated_at)
     VALUES
       ($1, 'member', 'test-member-v1', 'active', 'Test-only approved member formula',
        '["timeliness"]', '{"timeliness":1}', '["TEST"]', $3, $5, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
       ($2, 'chama', 'test-chama-v1', 'active', 'Test-only approved Chama formula',
        '["participation"]', '{"participation":1}', '["TEST"]', $4, $5, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [memberFormulaId, chamaFormulaId, 'a'.repeat(64), 'b'.repeat(64), ownerId],
  );

  const memberFactors = [{ code: 'TIMELINESS', label: 'Contribution timeliness', effect: 'positive' as const, summary: 'Recent obligations were met consistently' }];
  const chamaFactors = [{ code: 'PARTICIPATION', label: 'Participation consistency', effect: 'positive' as const, summary: 'Group participation is consistently verified' }];

  await assert.rejects(
    service.recordSnapshot({
      subjectType: 'member', formulaVersionId: memberFormulaId, membershipId,
      score: 70, level: 'TEST',
      factors: [{ code: 'RAW', label: 'Payment', effect: 'neutral', summary: 'Paid KES 5,000 via M-Pesa' }],
      calculationKey: 'member-test-calculation-raw', sourceFingerprint: '9'.repeat(64),
    }),
    /Raw private financial data/i,
  );

  await service.recordSnapshot({
    subjectType: 'member',
    formulaVersionId: memberFormulaId,
    membershipId,
    score: 76,
    level: 'TEST_GOOD',
    factors: memberFactors,
    calculationKey: 'member-test-calculation-001',
    sourceFingerprint: 'c'.repeat(64),
  });
  await service.recordSnapshot({
    subjectType: 'member',
    formulaVersionId: memberFormulaId,
    membershipId,
    score: 81,
    level: 'TEST_STRONG',
    factors: memberFactors,
    calculationKey: 'member-test-calculation-002',
    sourceFingerprint: 'd'.repeat(64),
  });
  await service.recordSnapshot({
    subjectType: 'chama',
    formulaVersionId: chamaFormulaId,
    chamaId,
    score: 88,
    level: 'TEST_STRONG',
    factors: chamaFactors,
    calculationKey: 'chama-test-calculation-001',
    sourceFingerprint: 'e'.repeat(64),
  });

  const currentMember = await service.getOwnMembershipTrust(membershipId, ownerId);
  assert.equal(currentMember.available, true);
  assert.equal(currentMember.score, 81);
  assert.equal(currentMember.version, 'test-member-v1');
  assert.deepEqual(currentMember.factors, memberFactors);

  const history = await service.getOwnMembershipHistory(membershipId, ownerId);
  assert.deepEqual(history.history.map((item) => item.score), [81, 76]);
  assert.equal(history.history.every((item) => item.version === 'test-member-v1'), true);

  const publicChama = await service.getPublicChamaTrust(chamaId);
  assert.equal(publicChama.available, true);
  assert.equal(publicChama.score, 88);
  assert.deepEqual(publicChama.factors, chamaFactors);

  await assert.rejects(service.getOwnMembershipTrust(membershipId, otherId), /private to the membership owner/);

  await assert.rejects(
    service.recordSnapshot({
      subjectType: 'member', formulaVersionId: memberFormulaId, membershipId,
      score: 82, level: 'TEST_STRONG', factors: memberFactors,
      calculationKey: 'member-test-calculation-002', sourceFingerprint: 'f'.repeat(64),
    }),
    /duplicate key|unique/i,
  );

  const snapshotId = (await pool.query(`SELECT id FROM trust_score_snapshots WHERE calculation_key = 'member-test-calculation-001'`)).rows[0].id;
  await assert.rejects(pool.query(`UPDATE trust_score_snapshots SET score = 99 WHERE id = $1`, [snapshotId]), /append-only/i);
  await assert.rejects(
    pool.query(`UPDATE trust_score_formula_versions SET weights = '{"timeliness":0.5}' WHERE id = $1`, [memberFormulaId]),
    /immutable/i,
  );

  const auditRows = await pool.query(
    `SELECT action, payload FROM audit_logs WHERE entity_type = 'trust_score_snapshot' ORDER BY created_at`,
  );
  assert.equal(auditRows.rows.length, 3);
  assert.equal(auditRows.rows.every((row) => row.action === 'trust_score_snapshot_created'), true);
  assert.equal(JSON.stringify(auditRows.rows).includes('contribution_amount'), false);
});
