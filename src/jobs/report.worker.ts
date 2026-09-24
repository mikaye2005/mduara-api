import { createHash, randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { ReportService, type ReportSnapshot, type ReportType } from '../services/report.service';
import { logger } from '../utils/logger';

interface ClaimedJob extends QueryResultRow {
  id: string;
  chama_id: string;
  membership_id: string | null;
  report_type: ReportType;
  format: 'pdf' | 'excel';
  period_from: string | null;
  period_to: string | null;
  attempts: number;
  lease_token: string;
}

export class ReportJobWorker {
  private readonly reports: ReportService;

  constructor(private readonly db: Pool, private readonly maxAttempts = 5) {
    this.reports = new ReportService(db);
  }

  async runBatch(limit: number, now = new Date(), isStopping: () => boolean = () => false) {
    const totals = { ready: 0, retried: 0, failed: 0, expired: 0 };
    const expired = await this.db.query(
      `UPDATE report_jobs
          SET status = 'expired', content = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= $1`,
      [now],
    );
    totals.expired = expired.rowCount;

    for (let i = 0; i < limit && !isStopping(); i += 1) {
      const job = await this.claim(now);
      if (!job) break;
      try {
        const snapshot = await this.reports.captureForJob({
          reportType: job.report_type,
          chamaId: job.chama_id,
          membershipId: job.membership_id,
          from: job.period_from,
          to: job.period_to,
        });
        if (snapshot.reportType === 'chama_financial_statement' && snapshot.summary.balanced !== true) {
          throw new Error('Ledger reconciliation failed: Chama report snapshot is not balanced');
        }

        const output = job.format === 'pdf' ? renderPdf(snapshot) : renderExcel(snapshot);
        const sha256 = createHash('sha256').update(output).digest('hex');
        const reconciliation = {
          ...snapshot.summary,
          snapshotAt: snapshot.snapshotAt,
          contentSha256: sha256,
        };
        const extension = job.format === 'pdf' ? 'pdf' : 'xls';
        const contentType = job.format === 'pdf' ? 'application/pdf' : 'application/vnd.ms-excel';
        const fileName = `${job.report_type}-${job.id}.${extension}`;
        const completed = await this.db.query(
          `WITH updated AS (
             UPDATE report_jobs
                SET status = 'ready', snapshot_at = $2, reconciliation = $3::jsonb,
                    content = $4, content_type = $5, file_name = $6, file_size = $7,
                    content_sha256 = $8, completed_at = $9, expires_at = $9::timestamptz + interval '7 days',
                    locked_until = NULL, lease_token = NULL, failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND status = 'processing' AND lease_token = $10
              RETURNING id
           )
           INSERT INTO audit_logs
             (category, action, actor_role, chama_id, entity_type, entity_id, payload)
           SELECT 'financial','report_export_generated','system',$11,'report_job',id,$12::jsonb
             FROM updated
           RETURNING id`,
          [
            job.id, snapshot.snapshotAt, JSON.stringify(reconciliation), output, contentType, fileName, output.length, sha256, now, job.lease_token,
            job.chama_id, JSON.stringify({
              reportType: job.report_type,
              format: job.format,
              snapshotAt: snapshot.snapshotAt,
              contentSha256: sha256,
              fileSize: output.length,
              reconciliation,
            }),
          ],
        );
        if (completed.rowCount === 1) totals.ready += 1;
      } catch (error) {
        const reason = safeFailure(error);
        if (job.attempts >= this.maxAttempts) {
          const failed = await this.db.query(
            `WITH updated AS (
               UPDATE report_jobs
                  SET status = 'failed', failure_reason = $2, completed_at = $3,
                      locked_until = NULL, lease_token = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1 AND lease_token = $4
                RETURNING id
             )
             INSERT INTO audit_logs
               (category, action, actor_role, chama_id, entity_type, entity_id, payload)
             SELECT 'system','report_export_failed','system',$5,'report_job',id,$6::jsonb
               FROM updated
             RETURNING id`,
            [
              job.id, reason, now, job.lease_token, job.chama_id,
              JSON.stringify({ reportType: job.report_type, format: job.format, attempts: job.attempts, failureReason: reason }),
            ],
          );
          if (failed.rowCount === 1) totals.failed += 1;
        } else {
          const delaySeconds = Math.min(900, 15 * 2 ** Math.max(0, job.attempts - 1));
          await this.db.query(
            `UPDATE report_jobs
                SET status = 'queued', failure_reason = $2,
                    available_at = $3::timestamptz + ($4 * interval '1 second'),
                    locked_until = NULL, lease_token = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND lease_token = $5`,
            [job.id, reason, now, delaySeconds, job.lease_token],
          );
          totals.retried += 1;
        }
        logger.warn('Report generation attempt failed', { reportJobId: job.id, attempts: job.attempts, error: reason });
      }
    }
    return totals;
  }

  private async claim(now: Date): Promise<ClaimedJob | null> {
    const token = randomUUID();
    const row = (await this.db.query<ClaimedJob>(
      `WITH candidate AS (
         SELECT id FROM report_jobs
          WHERE attempts < $3
            AND ((status = 'queued' AND available_at <= $1)
              OR (status = 'processing' AND locked_until <= $1))
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE report_jobs r
          SET status = 'processing', attempts = attempts + 1, lease_token = $2,
              locked_until = $1::timestamptz + interval '5 minutes',
              started_at = COALESCE(started_at, $1), updated_at = CURRENT_TIMESTAMP
         FROM candidate c
        WHERE r.id = c.id
       RETURNING r.id, r.chama_id, r.membership_id, r.report_type, r.format,
                 r.period_from::text, r.period_to::text, r.attempts, r.lease_token::text`,
      [now, token, this.maxAttempts],
    )).rows[0];
    return row ?? null;
  }
}

function safeFailure(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
}

function reportLines(snapshot: ReportSnapshot): string[] {
  const subject = snapshot.subject;
  const title = snapshot.reportType === 'chama_financial_statement' ? 'M-Duara Chama Financial Statement' : 'M-Duara Member Statement';
  const lines = [
    title,
    `Snapshot: ${snapshot.snapshotAt}`,
    `Period: ${snapshot.period.from ?? 'beginning'} to ${snapshot.period.to ?? 'snapshot'}`,
    snapshot.reportType === 'chama_financial_statement'
      ? `Chama: ${String(subject.chamaName ?? subject.chamaId ?? '')}`
      : `Member: ${String(subject.fullName ?? subject.membershipId ?? '')} | Chama: ${String(subject.chamaName ?? '')}`,
    `Entries: ${snapshot.summary.entryCount} | Transactions: ${snapshot.summary.transactionCount}`,
    `Debits: ${snapshot.summary.totalDebits} | Credits: ${snapshot.summary.totalCredits} | Net: ${snapshot.summary.net}`,
    snapshot.summary.balanced === null ? 'Ledger subset: member-scoped (not expected to balance independently)' : `Balanced: ${snapshot.summary.balanced ? 'YES' : 'NO'}`,
    '',
    'ACCOUNT SUMMARY',
    'Account | Debits | Credits | Net',
    ...snapshot.accounts.map((a) => `${a.account} | ${a.debits} | ${a.credits} | ${a.net}`),
    '',
    'LEDGER ENTRIES',
    'Timestamp | Reference | Operation | Account | Side | Amount | Currency | Member',
    ...snapshot.entries.map((e) => `${e.createdAt} | ${e.reference} | ${e.operationType} | ${e.account} | ${e.side} | ${e.amount} | ${e.currency} | ${e.memberId ?? ''}`),
  ];
  return lines.flatMap((line) => wrap(String(line), 94));
}

function renderPdf(snapshot: ReportSnapshot): Buffer {
  const allLines = reportLines(snapshot).map(pdfSafe);
  const pageSize = 48;
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += pageSize) pages.push(allLines.slice(i, i + pageSize));
  if (!pages.length) pages.push(['M-Duara report']);

  const objects: string[] = [];
  const fontId = 3;
  const pageIds = pages.map((_page, i) => 4 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  pages.forEach((page, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    const commands = ['BT', '/F1 8 Tf', '45 805 Td', '11 TL'];
    for (const line of page) commands.push(`(${escapePdf(line)}) Tj`, 'T*');
    commands.push('ET');
    const stream = commands.join('\n');
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n%M-Duara\n';
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function renderExcel(snapshot: ReportSnapshot): Buffer {
  const subjectRows = Object.entries(snapshot.subject).map(([key, value]) => rowXml([key, String(value ?? '')]));
  const summaryRows = [
    rowXml(['Field', 'Value']),
    rowXml(['Snapshot', snapshot.snapshotAt]),
    rowXml(['Period From', snapshot.period.from ?? '']), rowXml(['Period To', snapshot.period.to ?? '']),
    rowXml(['Entry Count', String(snapshot.summary.entryCount)]),
    rowXml(['Transaction Count', String(snapshot.summary.transactionCount)]),
    rowXml(['Total Debits', snapshot.summary.totalDebits]), rowXml(['Total Credits', snapshot.summary.totalCredits]),
    rowXml(['Net', snapshot.summary.net]), rowXml(['Balanced', snapshot.summary.balanced === null ? 'N/A' : String(snapshot.summary.balanced)]),
    ...subjectRows,
  ].join('');
  const accountRows = [rowXml(['Account', 'Debits', 'Credits', 'Net']), ...snapshot.accounts.map((a) => rowXml([a.account, a.debits, a.credits, a.net]))].join('');
  const ledgerRows = [
    rowXml(['Timestamp', 'Transaction ID', 'Reference', 'Operation', 'Member ID', 'Account', 'Side', 'Amount', 'Currency']),
    ...snapshot.entries.map((e) => rowXml([e.createdAt, e.transactionId, e.reference, e.operationType, e.memberId ?? '', e.account, e.side, e.amount, e.currency])),
  ].join('');
  const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    worksheetXml('Summary', summaryRows) + worksheetXml('Accounts', accountRows) + worksheetXml('Ledger', ledgerRows) + `</Workbook>`;
  return Buffer.from(xml, 'utf8');
}

function worksheetXml(name: string, rows: string) {
  return `<Worksheet ss:Name="${xmlEscape(name)}"><Table>${rows}</Table></Worksheet>`;
}
function rowXml(values: string[]) {
  return `<Row>${values.map((value) => `<Cell><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`).join('')}</Row>`;
}
function xmlEscape(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function pdfSafe(value: string) { return value.normalize('NFKD').replace(/[^\x20-\x7E]/g, '?'); }
function escapePdf(value: string) { return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function wrap(value: string, width: number) {
  if (value.length <= width) return [value];
  const result: string[] = [];
  let rest = value;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut < Math.floor(width * 0.5)) cut = width;
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  result.push(rest);
  return result;
}
