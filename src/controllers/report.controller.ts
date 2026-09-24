import type { NextFunction, Request, Response } from 'express';
import { reportService } from '../services/report.service';
import { reportJobIdSchema, reportQuerySchema } from '../validation/report.validation';
import { UnauthorizedError } from '../utils/errors';

export async function getChamaFinancialStatement(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = reportQuerySchema.parse(req.query);
    const range = { from: query.from, to: query.to };
    if (query.format === 'json') {
      const data = await reportService.getChamaFinancialStatement(req.user.id, req.params.id, range);
      res.json({ data });
      return;
    }
    const job = await reportService.enqueueChamaExport(req.user.id, req.params.id, query.format, range);
    res.status(202).json({
      data: job,
      meta: {
        statusPath: `/api/v1/reports/${job.id}`,
        downloadPath: `/api/v1/reports/${job.id}/download`,
      },
    });
  } catch (error) { next(error); }
}

export async function getMemberStatement(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = reportQuerySchema.parse(req.query);
    const range = { from: query.from, to: query.to };
    if (query.format === 'json') {
      const data = await reportService.getMemberStatement(req.user.id, req.params.id, range);
      res.json({ data });
      return;
    }
    const job = await reportService.enqueueMemberExport(req.user.id, req.params.id, query.format, range);
    res.status(202).json({
      data: job,
      meta: {
        statusPath: `/api/v1/reports/${job.id}`,
        downloadPath: `/api/v1/reports/${job.id}/download`,
      },
    });
  } catch (error) { next(error); }
}

export async function getReportStatus(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const jobId = reportJobIdSchema.parse(req.params.jobId);
    const job = await reportService.getJobStatus(req.user.id, jobId);
    res.json({ data: job });
  } catch (error) { next(error); }
}

export async function downloadReport(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const jobId = reportJobIdSchema.parse(req.params.jobId);
    const job = await reportService.getDownloadJob(req.user.id, jobId);
    if (job.status === 'queued' || job.status === 'processing') {
      res.status(202).json({ data: withoutContent(job) });
      return;
    }
    if (job.status === 'failed') {
      res.status(422).json({
        data: withoutContent(job),
        error: { code: 'REPORT_GENERATION_FAILED', message: job.failureReason ?? 'Report generation failed' },
      });
      return;
    }
    if (job.status === 'expired') {
      res.status(410).json({
        data: withoutContent(job),
        error: { code: 'REPORT_EXPIRED', message: 'Report download has expired; request a new export' },
      });
      return;
    }
    if (!job.content || !job.contentType || !job.fileName) {
      res.status(503).json({ error: { code: 'REPORT_OUTPUT_UNAVAILABLE', message: 'Report output is not available' } });
      return;
    }
    res.setHeader('Content-Type', job.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${job.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    if (job.contentSha256) res.setHeader('X-Content-SHA256', job.contentSha256);
    res.setHeader('Content-Length', String(job.content.length));
    res.send(job.content);
  } catch (error) { next(error); }
}

function withoutContent<T extends { content?: unknown }>(job: T) {
  const { content: _content, ...safe } = job;
  return safe;
}

export default { getChamaFinancialStatement, getMemberStatement, getReportStatus, downloadReport };
