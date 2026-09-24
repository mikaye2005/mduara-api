import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { assessContribution } from '../../jobs/penalties';
import { processLoanInterest } from '../../jobs/interest';
import { runFinancialScan } from '../../jobs/financial-scan';
import { enqueueReminders, ReminderDispatcher } from '../../jobs/reminders';
import { LedgerService, IdempotencyConflictError } from '../../services/ledger.service';
import { CommitmentService } from '../../services/commitment.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const timezone = 'Africa/Nairobi';
const options = { timezone, batchSize: 2 };
const midnight = new Date('2026-09-15T21:00:00.000Z'); // Sep 16, 00:00 Nairobi

test('background scheduling against PostgreSQL', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `scheduler_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  await migrate({ databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema, createSchema: true,
    migrationsSchema: schema, migrationsTable: 'pgmigrations', ignorePattern: '.*\\.sql', singleTransaction: false, log: () => {} });
  t.beforeEach(async () => {
    await pool.query("UPDATE chamas SET status = 'inactive'");
    await pool.query('DELETE FROM reminder_deliveries');
    await pool.query('DELETE FROM ledger_reconciliation_items');
    await pool.query('DELETE FROM ledger_reconciliation_runs');
    await cleanMpesaReconciliation();
  });

  async function cleanMpesaReconciliation(
    windowStart = '2026-09-01T00:00:00.000Z',
    windowEnd = '2026-10-01T00:00:00.000Z',
  ) {
    return (await pool.query(
      `INSERT INTO ledger_reconciliation_runs
       (provider, window_start, window_end, provider_record_count, matched_count, mismatch_count, completed_at)
       VALUES ('mpesa', $1, $2, 0, 0, 0, CURRENT_TIMESTAMP)
       RETURNING id`,
      [windowStart, windowEnd],
    )).rows[0].id as string;
  }

  async function fixture(input: { feeType?: string; fee?: string; percentage?: string; grace?: number; active?: boolean; memberActive?: boolean } = {}) {
    const user = (await pool.query(`INSERT INTO users (email, pin_hash, full_name, phone, status)
      VALUES ($1, '$2a$12$8sBAM5V4f1xFQvXtKQqS7uP8coKXZkV9g3Q1iKcYxn3VGcRJjKf6a', 'Member', $2, 'active') RETURNING id`, [`${randomUUID()}@example.test`, `+254${Date.now()}${Math.floor(Math.random() * 100000)}`])).rows[0].id;
    const chama = (await pool.query(`INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status)
      VALUES ('Test Chama', 'table_banking', 1000, 'monthly', $1) RETURNING id`, [input.active === false ? 'inactive' : 'active'])).rows[0].id;
    const member = (await pool.query(`INSERT INTO chama_members (chama_id, user_id, membership_status)
      VALUES ($1, $2, $3) RETURNING id`, [chama, user, input.memberActive === false ? 'exited' : 'active'])).rows[0].id;
    await pool.query(`INSERT INTO contribution_rules (chama_id, amount, frequency, late_fee, late_fee_type, late_fee_percentage, grace_period_days, effective_from)
      VALUES ($1, 1000, 'monthly', $2, $3, $4, $5, '2026-01-01')`, [chama, input.fee ?? '100', input.feeType ?? 'flat', input.percentage ?? '0', input.grace ?? 0]);
    return { user, chama, member };
  }
  async function contribution(f: Awaited<ReturnType<typeof fixture>>, due = '2026-09-15', status = 'pending') {
    return (await pool.query(`INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, period_label, status)
      VALUES ($1, $2, 1000, $3, 'September', $4) RETURNING id`, [f.chama, f.member, due, status])).rows[0].id as string;
  }
  async function payment(f: Awaited<ReturnType<typeof fixture>>, id: string, amount: number, paidAt: string, status = 'confirmed') {
    await pool.query(`INSERT INTO contribution_payments (contribution_id, chama_id, member_id, amount, payment_method, status, paid_at)
      VALUES ($1, $2, $3, $4, 'cash', $5, $6)`, [id, f.chama, f.member, amount, status, paidAt]);
  }
  async function loan(f: Awaited<ReturnType<typeof fixture>>, changes: { cycle?: number | null; next?: string | null; status?: string; due?: string } = {}) {
    return (await pool.query(`INSERT INTO loans (chama_id, member_id, principal_amount, interest_rate, total_due, status, interest_cycle_days, next_interest_date, due_date)
      VALUES ($1, $2, 1000, 10, 1100, $3, $4, $5, $6) RETURNING id`,
    [f.chama, f.member, changes.status ?? 'active', changes.cycle === undefined ? 30 : changes.cycle,
      changes.next === undefined ? '2026-09-16' : changes.next, changes.due ?? '2026-12-31'])).rows[0].id as string;
  }

  async function heldCommitment(f: Awaited<ReturnType<typeof fixture>>, defaultAfterMisses = 3) {
    await pool.query(`UPDATE chama_members SET membership_status = 'pending' WHERE id = $1`, [f.member]);
    const rule = (await pool.query(
      `INSERT INTO chama_rules
       (chama_id, version, status, contribution_amount, contribution_frequency,
        commitment_amount, default_after_consecutive_misses, effective_from, created_by)
       VALUES ($1, 1, 'active', 1000, 'monthly', 500, $2, CURRENT_TIMESTAMP, $3)
       RETURNING id`,
      [f.chama, defaultAfterMisses, f.user],
    )).rows[0].id as string;
    const application = (await pool.query(
      `INSERT INTO chama_applications
       (chama_id, user_id, status, chama_rule_id, constitution_accepted_at)
       VALUES ($1, $2, 'commitment_pending', $3, CURRENT_TIMESTAMP)
       RETURNING id`,
      [f.chama, f.user, rule],
    )).rows[0].id as string;
    await pool.query(
      `INSERT INTO membership_constitution_acceptances (chama_id, membership_id, chama_rule_id)
       VALUES ($1, $2, $3)`,
      [f.chama, f.member, rule],
    );
    await pool.query(
      `INSERT INTO commitment_deposits
       (chama_id, user_id, membership_id, application_id, chama_rule_id, amount, last_transition_reference)
       VALUES ($1, $2, $3, $4, $5, 500, $6)`,
      [f.chama, f.user, f.member, application, rule, `test-join:${randomUUID()}`],
    );
    await new CommitmentService(pool).confirmHoldFromProvider({
      membershipId: f.member,
      provider: 'test-provider',
      providerReference: `commitment-hold:${randomUUID()}`,
      amount: 500n,
    });
    return { rule, application };
  }

  await t.test('deadline creates one balanced member charge under concurrent workers and retries', async () => {
    const f = await fixture(); const id = await contribution(f);
    assert.equal(await assessContribution(pool, id, new Date(midnight.getTime() - 1), timezone), false);
    await Promise.all([assessContribution(pool, id, midnight, timezone), assessContribution(pool, id, midnight, timezone)]);
    assert.equal(await assessContribution(pool, id, midnight, timezone), false);
    const charges = await pool.query('SELECT * FROM penalties WHERE contribution_id = $1', [id]);
    assert.equal(charges.rowCount, 1); assert.equal(charges.rows[0].amount, '100');
    const entries = await pool.query('SELECT * FROM ledger_entries WHERE ledger_transaction_id = $1 ORDER BY side', [charges.rows[0].ledger_transaction_id]);
    assert.equal(entries.rowCount, 2);
    assert.equal(entries.rows.find((e) => e.side === 'debit').member_id, f.member);
    assert.equal(entries.rows.reduce((sum, e) => sum + (e.side === 'debit' ? BigInt(e.amount) : -BigInt(e.amount)), 0n), 0n);
    assert.equal((await pool.query('SELECT pooled_amount FROM chamas WHERE id = $1', [f.chama])).rows[0].pooled_amount, '0');
    assert.equal((await pool.query('SELECT status FROM contributions WHERE id = $1', [id])).rows[0].status, 'late');
  });
  await t.test('percentage fees use confirmed payments before the grace deadline and survive late settlement', async () => {
    const f = await fixture({ feeType: 'percentage', percentage: '2.50' });
    const id = await contribution(f, '2026-09-15', 'paid');
    await payment(f, id, 400, '2026-09-15T20:59:59Z');
    await payment(f, id, 600, '2026-09-15T21:00:01Z');
    await payment(f, id, 1000, '2026-09-15T20:00:00Z', 'pending');
    await assessContribution(pool, id, new Date('2026-09-16T01:00:00Z'), timezone);
    assert.equal((await pool.query('SELECT amount FROM penalties WHERE contribution_id = $1', [id])).rows[0].amount, '15');
    const assessed = (await pool.query('SELECT status, consecutive_miss_count, missed_at FROM contributions WHERE id = $1', [id])).rows[0];
    assert.equal(assessed.status, 'paid');
    assert.equal(assessed.consecutive_miss_count, 1);
    assert.ok(assessed.missed_at);
  });
  await t.test('penalties fail closed until a clean M-Pesa reconciliation covers the contribution window', async () => {
    const f = await fixture(); const id = await contribution(f);
    await pool.query(`DELETE FROM ledger_reconciliation_runs WHERE lower(provider) = 'mpesa'`);
    assert.equal(await assessContribution(pool, id, midnight, timezone), false);
    assert.equal((await pool.query('SELECT penalty_checked_at FROM contributions WHERE id = $1', [id])).rows[0].penalty_checked_at, null);

    await pool.query(
      `INSERT INTO ledger_reconciliation_runs
       (provider, window_start, window_end, provider_record_count, matched_count, mismatch_count, completed_at)
       VALUES ('mpesa', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 1, 0, 1, CURRENT_TIMESTAMP)`,
    );
    assert.equal(await assessContribution(pool, id, midnight, timezone), false);
    assert.equal((await pool.query('SELECT penalty_checked_at FROM contributions WHERE id = $1', [id])).rows[0].penalty_checked_at, null);

    await cleanMpesaReconciliation();
    assert.equal(await assessContribution(pool, id, midnight, timezone), true);
    assert.ok((await pool.query('SELECT penalty_checked_at FROM contributions WHERE id = $1', [id])).rows[0].penalty_checked_at);
  });

  await t.test('three consecutive reconciled misses automatically trigger member default and commitment default state', async () => {
    const f = await fixture();
    await heldCommitment(f, 3);
    const ids = [
      await contribution(f, '2026-09-13'),
      await contribution(f, '2026-09-14'),
      await contribution(f, '2026-09-15'),
    ];

    assert.equal(await assessContribution(pool, ids[0], midnight, timezone), true);
    assert.equal((await pool.query('SELECT consecutive_miss_count FROM contributions WHERE id = $1', [ids[0]])).rows[0].consecutive_miss_count, 1);
    assert.equal((await pool.query('SELECT state FROM commitment_deposits WHERE membership_id = $1', [f.member])).rows[0].state, 'at_risk');

    assert.equal(await assessContribution(pool, ids[1], midnight, timezone), true);
    assert.equal((await pool.query('SELECT consecutive_miss_count FROM contributions WHERE id = $1', [ids[1]])).rows[0].consecutive_miss_count, 2);
    assert.equal((await pool.query('SELECT membership_status FROM chama_members WHERE id = $1', [f.member])).rows[0].membership_status, 'active');

    assert.equal(await assessContribution(pool, ids[2], midnight, timezone), true);
    assert.equal((await pool.query('SELECT consecutive_miss_count FROM contributions WHERE id = $1', [ids[2]])).rows[0].consecutive_miss_count, 3);
    assert.equal((await pool.query('SELECT state FROM commitment_deposits WHERE membership_id = $1', [f.member])).rows[0].state, 'default_triggered');
    assert.equal((await pool.query('SELECT membership_status FROM chama_members WHERE id = $1', [f.member])).rows[0].membership_status, 'defaulted');
    assert.equal((await pool.query(
      `SELECT count(*)::int AS count FROM audit_logs
       WHERE entity_type = 'chama_member' AND entity_id = $1 AND action = 'contribution_default_triggered'`,
      [f.member],
    )).rows[0].count, 1);
  });

  await t.test('paid-on-time, waived, inactive groups and exited members are not charged', async () => {
    const f = await fixture(); const paid = await contribution(f, '2026-09-15', 'paid');
    await payment(f, paid, 1000, '2026-09-15T20:59:59Z');
    const waived = await contribution(f, '2026-09-15', 'waived');
    const inactive = await contribution(await fixture({ active: false }));
    const exited = await contribution(await fixture({ memberActive: false }));
    for (const id of [paid, waived, inactive, exited]) assert.equal(await assessContribution(pool, id, midnight, timezone), false);
  });
  await t.test('grace periods, rule effective dates, zero fees, and missing rules are respected', async () => {
    const f = await fixture({ grace: 2 }); const id = await contribution(f);
    assert.equal(await assessContribution(pool, id, midnight, timezone), false);
    await pool.query(`INSERT INTO contribution_rules (chama_id, amount, frequency, late_fee, effective_from) VALUES ($1, 1000, 'monthly', 999, '2026-09-16')`, [f.chama]);
    assert.equal(await assessContribution(pool, id, new Date('2026-09-17T21:00:00Z'), timezone), true);
    assert.equal((await pool.query('SELECT amount FROM penalties WHERE contribution_id = $1', [id])).rows[0].amount, '100');
    const zero = await contribution(await fixture({ fee: '0' }));
    assert.equal(await assessContribution(pool, zero, midnight, timezone), false);
    const missing = await fixture(); await pool.query('DELETE FROM contribution_rules WHERE chama_id = $1', [missing.chama]);
    assert.equal(await assessContribution(pool, await contribution(missing), midnight, timezone), false);
  });
  await t.test('row locks do not block ordinary reads; locked work is skipped and recovered', async () => {
    const f = await fixture(); const id = await contribution(f);
    const lock = await pool.connect(); const reader = await pool.connect();
    try {
      await lock.query('BEGIN'); await lock.query('SELECT id FROM contributions WHERE id = $1 FOR UPDATE', [id]);
      await reader.query("SET statement_timeout = '500ms'");
      assert.equal((await reader.query('SELECT status FROM contributions WHERE id = $1', [id])).rows[0].status, 'pending');
      assert.equal(await assessContribution(pool, id, midnight, timezone), false);
      await lock.query('COMMIT');
      assert.equal(await assessContribution(pool, id, midnight, timezone), true);
    } finally { await lock.query('ROLLBACK'); lock.release(); reader.release(); }
  });
  await t.test('an error after journal creation rolls back the entire penalty', async () => {
    const f = await fixture(); const id = await contribution(f);
    await pool.query(`CREATE FUNCTION reject_test_penalty() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`);
    await pool.query('CREATE TRIGGER reject_test_penalty BEFORE INSERT ON penalties FOR EACH ROW EXECUTE FUNCTION reject_test_penalty()');
    try { await assert.rejects(assessContribution(pool, id, midnight, timezone), /test failure/); }
    finally { await pool.query('DROP TRIGGER reject_test_penalty ON penalties'); await pool.query('DROP FUNCTION reject_test_penalty()'); }
    assert.equal((await pool.query('SELECT id FROM ledger_transactions WHERE reference = $1', [`contribution-penalty:${id}`])).rowCount, 0);
    assert.equal((await pool.query('SELECT penalty_checked_at FROM contributions WHERE id = $1', [id])).rows[0].penalty_checked_at, null);
    assert.equal(await assessContribution(pool, id, midnight, timezone), true);
  });
  await t.test('simple interest catches up each cycle once, ignores rule edits and stops at maturity', async () => {
    const f = await fixture(); const id = await loan(f, { next: '2026-07-18', due: '2026-09-16' });
    await pool.query(`INSERT INTO loan_rules (chama_id, interest_rate, max_borrowing_multiplier, interest_cycle_days)
      VALUES ($1, 99, 3, 1)`, [f.chama]);
    await pool.query(`INSERT INTO loan_repayments (loan_id, amount, payment_method, status) VALUES ($1, 500, 'cash', 'confirmed')`, [id]);
    for (let i = 0; i < 4; i += 1) await Promise.all([processLoanInterest(pool, id, midnight, timezone), processLoanInterest(pool, id, midnight, timezone)]);
    const result = (await pool.query('SELECT total_due, next_interest_date FROM loans WHERE id = $1', [id])).rows[0];
    assert.equal(result.total_due, '1400'); assert.equal(result.next_interest_date, null);
    assert.equal((await pool.query('SELECT id FROM loan_interest_accruals WHERE loan_id = $1', [id])).rowCount, 3);
    assert.equal(await processLoanInterest(pool, id, new Date('2027-01-01'), timezone), 0);
    for (const state of [{ cycle: null, next: null }, { status: 'repaid' }, { status: 'pending' }]) {
      const untouched = await loan(f, state); assert.equal(await processLoanInterest(pool, untouched, midnight, timezone), 0);
    }
  });
  await t.test('financial scan traverses multiple pages without missing contributions', async () => {
    const f = await fixture(); const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await contribution(f));
    const result = await runFinancialScan(pool, options, midnight);
    assert.equal(result.errors, 0);
    assert.equal((await pool.query('SELECT id FROM penalties WHERE contribution_id = ANY($1::uuid[])', [ids])).rowCount, 5);
  });
  await t.test('48-hour reminder boundary, both channels, loans, retries and concurrent dispatch', async () => {
    const f = await fixture(); const due = '2026-09-17';
    const cid = await contribution(f, due); const lid = await loan(f, { due, cycle: null, next: null });
    assert.equal(await enqueueReminders(pool, options, ['sms', 'email'], new Date(midnight.getTime() - 1)), 0);
    assert.equal(await enqueueReminders(pool, options, ['sms', 'email'], midnight), 4);
    assert.equal(await enqueueReminders(pool, options, ['sms', 'email'], midnight), 0);
    let fail = true; const sent = new Map<string, string>();
    const dispatcher = new ReminderDispatcher(pool, { async send(channel, to, subject, message, id) {
      // Prove provider calls release database connections, allowing ordinary reads.
      await pool.query('SELECT count(*) FROM contributions');
      if (fail && channel === 'sms') throw new Error('temporary provider failure');
      assert.ok(to); assert.match(message, /2026-09-17/); assert.ok(subject);
      assert.equal(sent.has(id), false); sent.set(id, message);
    } });
    const first = await dispatcher.dispatchBatch(10, midnight);
    assert.equal(first.sent, 2); assert.equal(first.retried, 2);
    fail = false;
    await Promise.all([dispatcher.dispatchBatch(10, new Date(midnight.getTime() + 60_000)), dispatcher.dispatchBatch(10, new Date(midnight.getTime() + 60_000))]);
    assert.equal(sent.size, 4);
    assert.equal((await pool.query("SELECT id FROM reminder_deliveries WHERE entity_id = ANY($1::uuid[]) AND status = 'sent'", [[cid, lid]])).rowCount, 4);
  });
  await t.test('settlement, rescheduling and expiry suppress stale reminders', async () => {
    const f = await fixture(); const paid = await contribution(f, '2026-09-17');
    const moved = await contribution(f, '2026-09-17'); const expired = await contribution(f, '2026-09-17');
    await enqueueReminders(pool, options, ['sms'], midnight);
    await payment(f, paid, 1000, midnight.toISOString());
    await pool.query("UPDATE contributions SET due_date = '2026-10-17' WHERE id = $1", [moved]);
    await pool.query('UPDATE reminder_deliveries SET expires_at = $2 WHERE entity_id = $1', [expired, midnight]);
    const dispatcher = new ReminderDispatcher(pool, { async send() { assert.fail('stale reminder sent'); } });
    assert.equal((await dispatcher.dispatchBatch(10, midnight)).cancelled, 3);
  });
  await t.test('crashed delivery leases recover and exhausted retries become failed', async () => {
    const f = await fixture(); const id = await contribution(f, '2026-09-17');
    await enqueueReminders(pool, options, ['email'], midnight);
    await pool.query(`UPDATE reminder_deliveries SET status = 'processing', locked_until = $2::timestamptz - interval '1 second',
      lease_token = gen_random_uuid() WHERE entity_id = $1`, [id, midnight]);
    const dispatcher = new ReminderDispatcher(pool, { async send() { throw new Error('provider unavailable'); } }, 1);
    assert.equal((await dispatcher.dispatchBatch(10, midnight)).failed, 1);
    assert.equal((await pool.query('SELECT status FROM reminder_deliveries WHERE entity_id = $1', [id])).rows[0].status, 'failed');
    assert.equal((await dispatcher.dispatchBatch(10, midnight)).failed, 0);
  });

  await t.test('ledger idempotency replays identical requests and rejects reference reuse with different financial instructions', async () => {
    const f = await fixture();
    const ledger = new LedgerService(pool);
    const reference = `test-deposit:${randomUUID()}`;
    const first = await ledger.recordDeposit({ chamaId: f.chama, amount: 1000n, reference, metadata: { provider: 'test-provider' } });
    const replay = await ledger.recordDeposit({ chamaId: f.chama, amount: 1000n, reference, metadata: { provider: 'test-provider' } });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.ledgerTransactionId, first.ledgerTransactionId);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_transactions WHERE reference = $1', [reference])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_entries WHERE ledger_transaction_id = $1', [first.ledgerTransactionId])).rows[0].count, 2);
    assert.equal((await pool.query('SELECT pooled_amount FROM chamas WHERE id = $1', [f.chama])).rows[0].pooled_amount, '1000');
    await assert.rejects(
      ledger.recordDeposit({ chamaId: f.chama, amount: 2000n, reference, metadata: { provider: 'test-provider' } }),
      IdempotencyConflictError,
    );
  });

  await t.test('ledger failures roll back completely and never allow a negative treasury', async () => {
    const f = await fixture();
    const ledger = new LedgerService(pool);
    const reference = `test-payout:${randomUUID()}`;
    await assert.rejects(
      ledger.recordPayout({ chamaId: f.chama, amount: 1n, reference }),
      /insufficient treasury funds/i,
    );
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger_transactions WHERE reference = $1', [reference])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT pooled_amount FROM chamas WHERE id = $1', [f.chama])).rows[0].pooled_amount, '0');
  });

  await t.test('provider reconciliation persists matched and mismatch evidence without a provider-specific SDK', async () => {
    const f = await fixture();
    const ledger = new LedgerService(pool);
    const matchedRef = `provider-match:${randomUUID()}`;
    const missingProviderRef = `provider-ledger-only:${randomUUID()}`;
    await ledger.recordDeposit({ chamaId: f.chama, amount: 700n, reference: matchedRef, metadata: { provider: 'test-provider' } });
    await ledger.recordDeposit({ chamaId: f.chama, amount: 300n, reference: missingProviderRef, metadata: { provider: 'test-provider' } });

    const result = await ledger.reconcileProviderWindow({
      provider: 'test-provider',
      windowStart: new Date('2020-01-01T00:00:00.000Z'),
      windowEnd: new Date('2030-01-01T00:00:00.000Z'),
      records: [
        { reference: matchedRef, amount: 700n, currency: 'KES' },
        { reference: `provider-only:${randomUUID()}`, amount: 900n, currency: 'KES' },
      ],
    });

    assert.ok(result.matched >= 1);
    assert.ok(result.items.some((item) => item.reference === matchedRef && item.status === 'matched'));
    assert.ok(result.items.some((item) => item.reference === missingProviderRef && item.status === 'missing_provider'));
    assert.ok(result.items.some((item) => item.status === 'missing_ledger'));
    const persisted = await pool.query('SELECT status FROM ledger_reconciliation_items WHERE run_id = $1', [result.runId]);
    assert.equal(persisted.rowCount, result.items.length);
  });

});
