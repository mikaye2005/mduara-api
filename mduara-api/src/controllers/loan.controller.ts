import type { Request, Response } from 'express';
import { loanService, type B2CResultPayload } from '../services/loan.service';
import { paymentService, verifyMpesaCallbackRequest } from '../services/payment.service';
import { BadRequestError } from '../utils/errors';
import { sendSuccess } from '../utils/response.util';
import type {
  ApplyLoanInput,
  RejectLoanInput,
  RepayLoanInput,
  UpsertLoanRuleInput,
} from '../validation/loan.validation';

export async function apply(req: Request<unknown, unknown, ApplyLoanInput>, res: Response): Promise<void> {
  const loan = await loanService.apply(req.user!.id, req.body);
  sendSuccess(res, loan, 201);
}

export async function getLoanRule(req: Request<{ chamaId: string }>, res: Response): Promise<void> {
  sendSuccess(res, await loanService.getRule(req.user!.id, req.params.chamaId));
}

export async function upsertLoanRule(
  req: Request<{ chamaId: string }, unknown, UpsertLoanRuleInput>,
  res: Response,
): Promise<void> {
  sendSuccess(res, await loanService.upsertRule(req.user!.id, req.params.chamaId, req.body));
}

export async function approveGuarantor(req: Request<{ id: string }>, res: Response): Promise<void> {
  sendSuccess(res, await loanService.acceptGuarantee(req.user!.id, req.params.id));
}

export async function approve(req: Request<{ id: string }>, res: Response): Promise<void> {
  const result = await loanService.approve(req.user!.id, req.params.id);
  sendSuccess(res, result, result.status === 'disbursement_pending' ? 202 : 200);
}

export async function reject(
  req: Request<{ id: string }, unknown, RejectLoanInput>,
  res: Response,
): Promise<void> {
  sendSuccess(res, await loanService.reject(req.user!.id, req.params.id, req.body));
}

export async function repay(req: Request<{ id: string }, unknown, RepayLoanInput>, res: Response): Promise<void> {
  const result = await loanService.recordRepaymentIntent(req.user!.id, req.params.id, req.body);
  sendSuccess(res, result, 202);
}

/** Daraja B2C ResultURL. Provider result, not dispatch acceptance, settles the payout state. */
export async function mpesaDisbursementResult(req: Request, res: Response): Promise<void> {
  await assertVerifiedMpesaCallback(req);
  const result = await loanService.processB2CResult(req.body as B2CResultPayload);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted', data: result });
}

/** Daraja B2C QueueTimeOutURL. A later successful result may still reconcile the failed local state. */
export async function mpesaDisbursementTimeout(req: Request, res: Response): Promise<void> {
  await assertVerifiedMpesaCallback(req);
  const result = await loanService.processB2CTimeout(req.body as B2CResultPayload);
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
      reason: `loan_b2c:${verification.reason}`,
      payload,
    });
  } catch {
    // Fail closed even when the security audit write itself cannot be persisted.
  }
  throw new BadRequestError('M-Pesa callback verification failed', undefined, 'MPESA_CALLBACK_UNVERIFIED');
}
