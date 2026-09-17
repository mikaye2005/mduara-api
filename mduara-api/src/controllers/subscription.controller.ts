import type { Request, Response } from 'express';
import { subscriptionService } from '../services/subscription.service';
import { paymentService, verifyMpesaCallbackRequest, type MpesaCallbackPayload } from '../services/payment.service';
import { BadRequestError } from '../utils/errors';
import { sendSuccess } from '../utils/response.util';
import type { SubscriptionPaymentInput } from '../validation/subscription.validation';

export async function listPlans(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await subscriptionService.listPlans());
}

export async function getChamaSubscription(req: Request<{ chamaId: string }>, res: Response): Promise<void> {
  sendSuccess(res, await subscriptionService.getForChama(req.user!.id, req.params.chamaId));
}

export async function pay(
  req: Request<Record<string, never>, unknown, SubscriptionPaymentInput>,
  res: Response,
): Promise<void> {
  sendSuccess(res, await subscriptionService.initiatePayment(req.user!.id, req.body), 202);
}

export async function paymentStatus(req: Request<{ checkoutId: string }>, res: Response): Promise<void> {
  sendSuccess(res, await subscriptionService.getPaymentStatus(req.user!.id, req.params.checkoutId));
}

export async function mpesaCallback(req: Request, res: Response): Promise<void> {
  await assertVerifiedMpesaCallback(req);
  const result = await subscriptionService.processStkCallback(req.body as MpesaCallbackPayload);
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
      reason: `subscription_stk:${verification.reason}`,
      payload,
    });
  } catch {
    // Verification remains fail-closed even when the security audit store is unavailable.
  }
  throw new BadRequestError('M-Pesa callback verification failed', undefined, 'MPESA_CALLBACK_UNVERIFIED');
}
