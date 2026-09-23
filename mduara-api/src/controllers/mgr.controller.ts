import type { Request, Response } from 'express';
import { merryGoRoundService, type MgrB2CResultPayload } from '../services/mgr.service';
import { paymentService, verifyMpesaCallbackRequest } from '../services/payment.service';
import { BadRequestError } from '../utils/errors';
import { sendSuccess } from '../utils/response.util';
import type { CreateMgrCycleInput, MgrSwapDecisionInput, MgrSwapRequestInput } from '../validation/mgr.validation';

export async function createCycle(
  req: Request<{ chamaId: string }, unknown, CreateMgrCycleInput>,
  res: Response,
): Promise<void> {
  sendSuccess(res, await merryGoRoundService.createCycle(req.user!.id, req.params.chamaId, req.body), 201);
}

export async function getCurrentCycle(req: Request<{ chamaId: string }>, res: Response): Promise<void> {
  sendSuccess(res, await merryGoRoundService.getCurrentCycle(req.user!.id, req.params.chamaId));
}

export async function getCycle(req: Request<{ cycleId: string }>, res: Response): Promise<void> {
  sendSuccess(res, await merryGoRoundService.getCycle(req.user!.id, req.params.cycleId));
}

export async function requestSwap(
  req: Request<{ cycleId: string }, unknown, MgrSwapRequestInput>,
  res: Response,
): Promise<void> {
  sendSuccess(res, await merryGoRoundService.requestSwap(req.user!.id, req.params.cycleId, req.body), 201);
}

export async function decideSwap(
  req: Request<{ cycleId: string; swapId: string }, unknown, MgrSwapDecisionInput>,
  res: Response,
): Promise<void> {
  sendSuccess(res, await merryGoRoundService.decideSwap(req.user!.id, req.params.cycleId, req.params.swapId, req.body));
}

export async function disburse(req: Request<{ cycleId: string }>, res: Response): Promise<void> {
  sendSuccess(res, await merryGoRoundService.disburse(req.user!.id, req.params.cycleId), 202);
}

export async function mpesaResult(req: Request, res: Response): Promise<void> {
  await assertVerifiedMpesaCallback(req);
  const result = await merryGoRoundService.processB2CResult(req.body as MgrB2CResultPayload);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted', data: result });
}

export async function mpesaTimeout(req: Request, res: Response): Promise<void> {
  await assertVerifiedMpesaCallback(req);
  const result = await merryGoRoundService.processB2CTimeout(req.body as MgrB2CResultPayload);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted', data: result });
}

async function assertVerifiedMpesaCallback(req: Request): Promise<void> {
  const payload = req.body as unknown;
  const verification = verifyMpesaCallbackRequest({
    ipAddress: req.ip,
    signature: req.header('x-mduara-signature') ?? req.header('x-callback-signature') ?? undefined,
    payload,
  });
  if (verification.ok) return;
  try {
    await paymentService.recordRejectedCallback({
      ipAddress: req.ip,
      reason: `mgr_b2c:${verification.reason}`,
      payload,
    });
  } catch {
    // Fail closed even if the security audit write is unavailable.
  }
  throw new BadRequestError('M-Pesa callback verification failed', undefined, 'MPESA_CALLBACK_UNVERIFIED');
}
