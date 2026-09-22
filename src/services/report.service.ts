import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { assertSubscriptionFeature } from './subscription.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';

export type ReportFormat = 'pdf' | 'excel';
export type ReportType = 'chama_financial_statement' | 'member_statement';
export interface ReportRange { from?: string; to?: string; }

export interface LedgerReportEntry {
  transactionId: string;
  reference: string;
  operationType: string;
  createdAt: string;
  memberId: string | null;
  account: string;
  side: 'debit' | 'credit';
  amount: string;
  currency: string;
}

export interface ReportSnapshot {
  reportType: ReportType;
  snapshotAt: string;
  period: { from: string | null; to: string | null };
  subject: Record<string, unknown>;
  summary: {
    entryCount: number;
    transactionCount: number;
    totalDebits: string;
    totalCredits: string;
    net: string;
    balanced: boolean | null;
  };
  accounts: Array<{ account: string; debits: string; credits: string; net: string }>;
  entries: LedgerReportEntry[];
}

interface JobRow extends QueryResultRow {
  id: string;
  requested_by: string;
  chama_id: string;
  membership_id: string | null;
  report_type: ReportType;
  format: ReportFormat;
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'expired';
  period_from: string | null;
  period_to: string | null;
  snapshot_at: string | null;
  reconciliation: Record<string, unknown>;
  content: Buffer | null;
  content_type: string | null;
  file_name: string | null;
  file_size: string | null;
  content_sha256: string | null;
  attempts: number;
  failure_reason: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

interface EntryRow extends QueryResultRow {
  transaction_id: string;
  reference: string;
  operation_type: string;
  transaction_created_at: string;
  member_id: string | null;
  account: string;
  side: 'debit' | 'credit';
  amount: string;
  currency: string;
  entry_id: string;
}

export class ReportService {
  constructor(private readonly db: Pool = pool) {}

  async getChamaFinancialStatement(actorId: string, chamaId: string, range: ReportRange) {
    await this.requireChamaLeadership(actorId, chamaId);
    return this.captureSnapshot({ reportType: 'chama_financial_statement', chamaId, membershipId: null, range });
  }

  async getMemberStatement(actorId: string, membershipId: string, range: ReportRange) {
    const membership = await this.requireMemberStatementAccess(actorId, membershipId);
    return this.captureSnapshot({ reportType: 'member_statement', chamaId: membership.chamaId, membershipId, range });
  }

  async enqueueChamaExport(actorId: string, chamaId: string, format: ReportFormat, range: ReportRange) {
    await this.requireChamaLeadership(actorId, chamaId);
    if (format === 'pdf') await assertSubscriptionFeature(this.db, chamaId, 'detailed_pdf_export');
    return this.enqueue({ actorId, chamaId, membershipId: null, reportType: 'chama_financial_statement', format, range });
  }

  async enqueueMemberExport(actorId: string, membershipId: string, format: ReportFormat, range: ReportRange) {
    const membership = await this.requireMemberStatementAccess(actorId, membershipId);
    if (format === 'pdf') await assertSubscriptionFeature(this.db, membership.chamaId, 'detailed_pdf_export');
    return this.enqueue({ actorId, chamaId: membership.chamaId, membershipId, reportType: 'member_statement', format, range });
  }

  async getJobStatus(actorId: string, jobId: string) {
    const job = await this.loadJob(jobId, false);
    await this.assertJobAccess(actorId, job);
    return this.expireIfNeeded(job, false);
  }

  async getDownloadJob(actorId: string, jobId: string) {
    const job = await this.loadJob(jobId, true);
    await this.assertJobAccess(actorId, job);
    return this.expireIfNeeded(job, true);
  }

  async captureForJob(job: { reportType: ReportType; chamaId: string; membershipId: string | null; from?: string | null; to?: string | null }) {
    return this.captureSnapshot({
      reportType: job.reportType,
      chamaId: job.chamaId,
      membershipId: job.membershipId,
      range: { from: job.from ?? undefined, to: job.to ?? undefined },
    });
  }

  private async enqueue(input: {
    actorId: string; chamaId: string; membershipId: string | null; reportType: ReportType; format: ReportFormat; range: ReportRange;
  }) {
    return withDatabaseTransaction(async (client) => {
      const row = (await client.query<JobRow>(
        `INSERT INTO report_jobs
           (requested_by, chama_id, membership_id, report_type, format, period_from, period_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, requested_by, chama_id, membership_id, report_type, format, status,
                   period_from::text, period_to::text, snapshot_at::text, reconciliation,
                   NULL::bytea AS content, content_type, file_name, file_size::text, content_sha256,
                   attempts, failure_reason, created_at::text, completed_at::text, expires_at::text`,
        [input.actorId, input.chamaId, input.membershipId, input.reportType, input.format, input.range.from ?? null, input.range.to ?? null],
      )).rows[0];

      await client.query(
        `INSERT INTO audit_logs
           (category, action, actor_id, chama_id, entity_type, entity_id, payload)
         VALUES ('financial','report_export_requested',$1,$2,'report_job',$3,$4::jsonb)`,
        [
          input.actorId,
          input.chamaId,
          row.id,
          JSON.stringify({
            reportType: input.reportType,
            format: input.format,
            membershipId: input.membershipId,
            period: { from: input.range.from ?? null, to: input.range.to ?? null },
          }),
        ],
      );
      return mapJob(row);
    }, {}, this.db);
  }

  private async loadJob(jobId: string, includeContent: boolean) {
    const row = (await this.db.query<JobRow>(
      `SELECT id, requested_by, chama_id, membership_id, report_type, format, status,
              period_from::text, period_to::text, snapshot_at::text, reconciliation,
              ${includeContent ? 'content' : 'NULL::bytea AS content'},
              content_type, file_name, file_size::text, content_sha256,
              attempts, failure_reason, created_at::text, completed_at::text, expires_at::text
         FROM report_jobs WHERE id = $1`,
      [jobId],
    )).rows[0];
    if (!row) throw new NotFoundError('Report job not found', 'REPORT_JOB_NOT_FOUND');
    return row;
  }

  private async assertJobAccess(actorId: string, job: JobRow) {
    if (job.requested_by === actorId) return;
    const admin = await this.db.query(`SELECT 1 FROM users WHERE id = $1 AND is_platform_admin = TRUE`, [actorId]);
    if (!admin.rowCount) throw new ForbiddenError('Report access is restricted to its requester', 'REPORT_ACCESS_FORBIDDEN');
  }

  private async expireIfNeeded(job: JobRow, includeContent: boolean) {
    if (job.status === 'ready' && job.expires_at && new Date(job.expires_at) <= new Date()) {
      await this.db.query(
        `UPDATE report_jobs
            SET status = 'expired', content = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'ready'`,
        [job.id],
      );
      return { ...mapJob(job), status: 'expired' as const, ...(includeContent ? { content: null as Buffer | null } : {}) };
    }
    return { ...mapJob(job), ...(includeContent ? { content: job.content } : {}) };
  }

  private async requireChamaLeadership(actorId: string, chamaId: string) {
    const membership = (await this.db.query<{ role: string }>(
      `SELECT role::text AS role FROM chama_members
        WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
      [chamaId, actorId],
    )).rows[0];
    if (!membership || !['chairperson', 'treasurer', 'secretary'].includes(membership.role)) {
      throw new ForbiddenError('Chama leadership access required for financial statements', 'REPORT_CHAMA_LEADERSHIP_REQUIRED');
    }
  }

  private async requireMemberStatementAccess(actorId: string, membershipId: string) {
    const membership = (await this.db.query<{ chama_id: string; user_id: string }>(
      `SELECT chama_id, user_id FROM chama_members WHERE id = $1`, [membershipId],
    )).rows[0];
    if (!membership) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
    if (membership.user_id === actorId) return { chamaId: membership.chama_id, userId: membership.user_id };
    const leader = await this.db.query(
      `SELECT 1 FROM chama_members
        WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'
          AND role IN ('chairperson','treasurer','secretary')`,
      [membership.chama_id, actorId],
    );
    if (!leader.rowCount) throw new ForbiddenError('Member statement access denied', 'REPORT_MEMBER_STATEMENT_FORBIDDEN');
    return { chamaId: membership.chama_id, userId: membership.user_id };
  }

  private async captureSnapshot(input: { reportType: ReportType; chamaId: string; membershipId: string | null; range: ReportRange }): Promise<ReportSnapshot> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshotAt = (await client.query<{ snapshot_at: string }>(`SELECT transaction_timestamp()::text AS snapshot_at`)).rows[0].snapshot_at;
      const subject = input.reportType === 'chama_financial_statement'
        ? await loadChamaSubject(client, input.chamaId)
        : await loadMemberSubject(client, input.chamaId, input.membershipId!);
      const entries = await loadLedgerEntries(client, input.chamaId, input.membershipId, input.range);
      await client.query('COMMIT');
      return buildSnapshot(input.reportType, snapshotAt, input.range, subject, entries);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadChamaSubject(client: PoolClient, chamaId: string) {
  const row = (await client.query<{ id: string; name: string; currency: string; status: string }>(
    `SELECT id, name, currency, status::text AS status FROM chamas WHERE id = $1`, [chamaId],
  )).rows[0];
  if (!row) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');
  return { chamaId: row.id, chamaName: row.name, currency: row.currency, status: row.status };
}

async function loadMemberSubject(client: PoolClient, chamaId: string, membershipId: string) {
  const row = (await client.query<{
    membership_id: string; user_id: string; full_name: string; role: string; membership_status: string; joined_at: string; chama_name: string; currency: string;
  }>(
    `SELECT cm.id AS membership_id, cm.user_id, u.full_name, cm.role::text AS role,
            cm.membership_status::text AS membership_status, cm.joined_at::text,
            c.name AS chama_name, c.currency
       FROM chama_members cm
       JOIN users u ON u.id = cm.user_id
       JOIN chamas c ON c.id = cm.chama_id
      WHERE cm.id = $1 AND cm.chama_id = $2`,
    [membershipId, chamaId],
  )).rows[0];
  if (!row) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');
  return {
    membershipId: row.membership_id, userId: row.user_id, fullName: row.full_name,
    role: row.role, membershipStatus: row.membership_status, joinedAt: row.joined_at,
    chamaId, chamaName: row.chama_name, currency: row.currency,
  };
}

async function loadLedgerEntries(client: PoolClient, chamaId: string, membershipId: string | null, range: ReportRange) {
  const entries: LedgerReportEntry[] = [];
  let cursorAt = '0001-01-01T00:00:00Z';
  let cursorId = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const result = await client.query<EntryRow>(
      `SELECT le.id AS entry_id, le.ledger_transaction_id AS transaction_id,
              lt.reference, lt.operation_type, lt.created_at::text AS transaction_created_at,
              le.member_id, le.account::text AS account, le.side::text AS side,
              le.amount::text, le.currency
         FROM ledger_entries le
         JOIN ledger_transactions lt ON lt.id = le.ledger_transaction_id
        WHERE le.chama_id = $1
          AND ($2::uuid IS NULL OR le.member_id = $2::uuid)
          AND ($3::date IS NULL OR lt.created_at >= ($3::date::timestamp AT TIME ZONE $5))
          AND ($4::date IS NULL OR lt.created_at < (($4::date + INTERVAL '1 day') AT TIME ZONE $5))
          AND (lt.created_at, le.id) > ($6::timestamptz, $7::uuid)
        ORDER BY lt.created_at, le.id
        LIMIT 1000`,
      [chamaId, membershipId, range.from ?? null, range.to ?? null, env.SCHEDULER_TIMEZONE, cursorAt, cursorId],
    );
    if (!result.rows.length) break;
    for (const row of result.rows) {
      entries.push({
        transactionId: row.transaction_id, reference: row.reference, operationType: row.operation_type,
        createdAt: row.transaction_created_at, memberId: row.member_id, account: row.account,
        side: row.side, amount: row.amount, currency: row.currency,
      });
    }
    const last = result.rows[result.rows.length - 1];
    cursorAt = last.transaction_created_at;
    cursorId = last.entry_id;
    if (result.rows.length < 1000) break;
  }
  return entries;
}

function buildSnapshot(reportType: ReportType, snapshotAt: string, range: ReportRange, subject: Record<string, unknown>, entries: LedgerReportEntry[]): ReportSnapshot {
  const expectedCurrency = typeof subject.currency === 'string' ? subject.currency : null;
  const currencies = new Set(entries.map((entry) => entry.currency));
  if (expectedCurrency && [...currencies].some((currency) => currency !== expectedCurrency)) {
    throw new ConflictError(
      'Ledger contains mixed or unexpected currencies; report generation stopped to avoid invalid totals',
      'REPORT_CURRENCY_MISMATCH',
    );
  }
  if (!expectedCurrency && currencies.size > 1) {
    throw new ConflictError('Ledger contains multiple currencies; report totals cannot be combined', 'REPORT_MULTIPLE_CURRENCIES');
  }

  let debits = 0n;
  let credits = 0n;
  const transactions = new Set<string>();
  const accounts = new Map<string, { debit: bigint; credit: bigint }>();
  for (const entry of entries) {
    const amount = BigInt(entry.amount);
    transactions.add(entry.transactionId);
    const bucket = accounts.get(entry.account) ?? { debit: 0n, credit: 0n };
    if (entry.side === 'debit') { debits += amount; bucket.debit += amount; }
    else { credits += amount; bucket.credit += amount; }
    accounts.set(entry.account, bucket);
  }
  return {
    reportType,
    snapshotAt,
    period: { from: range.from ?? null, to: range.to ?? null },
    subject,
    summary: {
      entryCount: entries.length,
      transactionCount: transactions.size,
      totalDebits: debits.toString(),
      totalCredits: credits.toString(),
      net: (debits - credits).toString(),
      balanced: reportType === 'chama_financial_statement' ? debits === credits : null,
    },
    accounts: [...accounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([account, value]) => ({
      account, debits: value.debit.toString(), credits: value.credit.toString(), net: (value.debit - value.credit).toString(),
    })),
    entries,
  };
}

function mapJob(row: JobRow) {
  return {
    id: row.id,
    requestedBy: row.requested_by,
    chamaId: row.chama_id,
    membershipId: row.membership_id,
    reportType: row.report_type,
    format: row.format,
    status: row.status,
    period: { from: row.period_from, to: row.period_to },
    snapshotAt: row.snapshot_at,
    reconciliation: row.reconciliation ?? {},
    contentType: row.content_type,
    fileName: row.file_name,
    fileSize: row.file_size,
    contentSha256: row.content_sha256,
    attempts: row.attempts,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

export const reportService = new ReportService();
