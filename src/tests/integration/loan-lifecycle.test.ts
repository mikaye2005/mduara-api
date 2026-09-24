import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { LoanService } from '../../services/loan.service';
import { hashSecret } from '../../utils/crypto.util';
import { ForbiddenError, UnprocessableEntityError } from '../../utils/errors';

const databaseUrl = process.env.TEST_DATABASE_URL;

class FakePayoutGateway {
  readonly requests: Array<{ amount: bigint; phoneNumber: string; reference: string; remarks: string }> = [];
  async dispatchB2CPayout(request: { amount: bigint; phoneNumber: string; reference: string; remarks: string }) {
    this.requests.push(request);
    return { providerReference: `conv-${request.reference}` };
  }
}

test('BE-07 loan origination, collateral, sequential approval and provider-confirmed disbursement', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `loan_be07_${randomUUID().replace(/-/g, '')}`;
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

  const pinHash = await hashSecret('2468');
  async function createUser(name: string, phone: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [`${randomUUID()}@example.test`, pinHash, name, phone],
    )).rows[0];
  }

  const borrower = await createUser('Loan Borrower', '+254700010001');
  const treasurer = await createUser('Loan Treasurer', '+254700010002');
  const chair = await createUser('Loan Chair', '+254700010003');
  const guarantorA = await createUser('Guarantor A', '+254700010004');
  const guarantorB = await createUser('Guarantor B', '+254700010005');

  const chama = (await pool.query<{ id: string }>(
    `INSERT INTO chamas
       (name, type, status, visibility, contribution_amount, contribution_frequency, pooled_amount)
     VALUES ('BE-07 Chama','table_banking','active','private',1000,'monthly',50000)
     RETURNING id`,
  )).rows[0];

  async function addMember(userId: string, role: 'member' | 'treasurer' | 'chairperson') {
    return (await pool.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status, joined_at)
       VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP) RETURNING id`,
      [chama.id, userId, role],
    )).rows[0];
  }

  const borrowerMembership = await addMember(borrower.id, 'member');
  await addMember(treasurer.id, 'treasurer');
  await addMember(chair.id, 'chairperson');
  const guarantorAMembership = await addMember(guarantorA.id, 'member');
  const guarantorBMembership = await addMember(guarantorB.id, 'member');

  await pool.query(
    `INSERT INTO loan_rules
       (chama_id, interest_rate, max_borrowing_multiplier, min_guarantors, max_term_days, created_by)
     VALUES ($1,10,3,2,365,$2)`,
    [chama.id, treasurer.id],
  );

  async function seedSavings(memberId: string, amount: number, label: string) {
    const contribution = (await pool.query<{ id: string }>(
      `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, status, period_label)
       VALUES ($1,$2,$3,CURRENT_DATE,'paid',$4) RETURNING id`,
      [chama.id, memberId, amount, label],
    )).rows[0];
    await pool.query(
      `INSERT INTO contribution_payments
         (contribution_id, chama_id, member_id, amount, payment_method, provider_reference, status)
       VALUES ($1,$2,$3,$4,'mpesa',$5,'confirmed')`,
      [contribution.id, chama.id, memberId, amount, `seed-${label}`],
    );
  }

  await seedSavings(borrowerMembership.id, 5000, 'borrower');
  await seedSavings(guarantorAMembership.id, 10000, 'guarantor-a');
  await seedSavings(guarantorBMembership.id, 10000, 'guarantor-b');

  const gateway = new FakePayoutGateway();
  const service = new LoanService(pool, gateway);

  await t.test('application above the configured savings multiplier returns 422 semantics', async () => {
    await assert.rejects(
      service.apply(borrower.id, {
        chamaId: chama.id,
        amount: 16000,
        guarantors: [
          { memberId: guarantorAMembership.id, guaranteedAmount: 8000 },
          { memberId: guarantorBMembership.id, guaranteedAmount: 8000 },
        ],
      }),
      (error: unknown) => error instanceof UnprocessableEntityError && error.code === 'LOAN_CAPACITY_EXCEEDED',
    );
  });

  const loan = await service.apply(borrower.id, {
    chamaId: chama.id,
    amount: 9000,
    purpose: 'Working capital',
    guarantors: [
      { memberId: guarantorAMembership.id, guaranteedAmount: 4500 },
      { memberId: guarantorBMembership.id, guaranteedAmount: 4500 },
    ],
  });
  assert.equal(loan.status, 'awaiting_guarantors');

  await t.test('accepted guarantees lock savings immediately and 100% coverage advances the loan', async () => {
    const first = await service.acceptGuarantee(guarantorA.id, loan.id);
    assert.equal(first.loanStatus, 'awaiting_guarantors');
    assert.equal(first.coverageAmount, '4500');

    const second = await service.acceptGuarantee(guarantorB.id, loan.id);
    assert.equal(second.loanStatus, 'pending_admin_approval');
    assert.equal(second.coverageAmount, '9000');
    assert.equal(second.approvedCount, 2);
  });

  await t.test('Chair cannot skip Treasurer; Treasurer approval is partial and audit-logged', async () => {
    await assert.rejects(
      service.approve(chair.id, loan.id),
      (error: unknown) => error instanceof ForbiddenError && error.code === 'LOAN_TREASURER_APPROVAL_REQUIRED',
    );

    const firstApproval = await service.approve(treasurer.id, loan.id);
    assert.equal(firstApproval.status, 'partially_approved');
    assert.equal(gateway.requests.length, 0);

    const audit = await pool.query(
      `SELECT actor_id, actor_role FROM audit_logs
       WHERE entity_type = 'loan' AND entity_id = $1 AND action = 'loan_treasurer_approved'`,
      [loan.id],
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_id, treasurer.id);
    assert.equal(audit.rows[0].actor_role, 'treasurer');
  });

  await t.test('Chair approval dispatches B2C but remains pending until provider result', async () => {
    const finalApproval = await service.approve(chair.id, loan.id);
    assert.equal(finalApproval.status, 'disbursement_pending');
    assert.equal(gateway.requests.length, 1);

    const beforeResult = (await pool.query(
      `SELECT l.status::text AS loan_status, ld.status::text AS disbursement_status, ld.provider_reference
       FROM loans l JOIN loan_disbursements ld ON ld.loan_id = l.id WHERE l.id = $1`,
      [loan.id],
    )).rows[0];
    assert.equal(beforeResult.loan_status, 'disbursement_pending');
    assert.equal(beforeResult.disbursement_status, 'pending');
    assert.equal(beforeResult.provider_reference, `conv-${loan.id}`);
  });

  await t.test('provider-confirmed B2C result writes loan ledger and marks DISBURSED exactly once', async () => {
    const result = await service.processB2CResult({
      Result: {
        ResultCode: 0,
        ResultDesc: 'Success',
        ConversationID: `conv-${loan.id}`,
        TransactionID: 'TX-BE07-001',
        ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 9000 }] },
      },
    });
    assert.equal(result.status, 'disbursed');

    const row = (await pool.query<{ status: string; pooled_amount: string }>(
      `SELECT l.status::text AS status, c.pooled_amount::text
       FROM loans l JOIN chamas c ON c.id = l.chama_id WHERE l.id = $1`,
      [loan.id],
    )).rows[0];
    assert.equal(row.status, 'disbursed');
    assert.equal(row.pooled_amount, '41000');

    const ledger = await pool.query(
      `SELECT lt.operation_type, le.account::text, le.side::text, le.amount::text
       FROM ledger_transactions lt JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
       WHERE lt.reference = 'loan-disbursement:TX-BE07-001'
       ORDER BY le.side, le.account`,
    );
    assert.equal(ledger.rowCount, 2);
    assert.equal(ledger.rows.every((entry) => entry.operation_type === 'loan_disbursement'), true);

    const replay = await service.processB2CResult({
      Result: { ResultCode: 0, ConversationID: `conv-${loan.id}`, TransactionID: 'TX-BE07-001' },
    });
    assert.equal(replay.replayed, true);
    assert.equal((await pool.query(`SELECT pooled_amount::text FROM chamas WHERE id = $1`, [chama.id])).rows[0].pooled_amount, '41000');
  });

  await t.test('rejection releases a guarantor pledge for subsequent loans', async () => {
    const rejectedCandidate = await service.apply(borrower.id, {
      chamaId: chama.id,
      amount: 4000,
      guarantors: [
        { memberId: guarantorAMembership.id, guaranteedAmount: 2000 },
        { memberId: guarantorBMembership.id, guaranteedAmount: 2000 },
      ],
    });
    await service.acceptGuarantee(guarantorA.id, rejectedCandidate.id);
    const rejected = await service.reject(treasurer.id, rejectedCandidate.id, { reason: 'Applicant withdrew before review' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.collateralReleased, true);

    const nextLoan = await service.apply(borrower.id, {
      chamaId: chama.id,
      amount: 6500,
      guarantors: [
        { memberId: guarantorAMembership.id, guaranteedAmount: 5500 },
        { memberId: guarantorBMembership.id, guaranteedAmount: 1000 },
      ],
    });
    const accepted = await service.acceptGuarantee(guarantorA.id, nextLoan.id);
    assert.equal(accepted.approved, true);
  });
});
