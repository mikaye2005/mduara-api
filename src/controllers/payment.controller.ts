import type { NextFunction, Request, Response } from 'express';
import { paymentService, verifyMpesaCallbackRequest, type MpesaCallbackPayload } from '../services/payment.service';
import { checkoutIdSchema, stkPushSchema } from '../validation/payment.validation';
import { BadRequestError, UnauthorizedError } from '../utils/errors';

export async function initiateStkPush(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = stkPushSchema.parse(req.body);
    const result = await paymentService.initiateStkPush({
      userId: req.user.id,
      contributionId: input.contributionId,
      amount: BigInt(input.amount),
      phoneNumber: input.phoneNumber,
    });
    res.status(202).json({ data: result });
  } catch (error) { next(error); }
}

export async function getPaymentStatus(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const checkoutId = checkoutIdSchema.parse(req.params.checkoutId);
    const result = await paymentService.getStatus(checkoutId, req.user.id);
    res.json({ data: result });
  } catch (error) { next(error); }
}

export async function mpesaCallback(req: Request, res: Response, next: NextFunction) {
  const payload = req.body as MpesaCallbackPayload;
  const verification = verifyMpesaCallbackRequest({
    ipAddress: req.ip,
    signature: req.header('x-mduara-signature') ?? req.header('x-callback-signature') ?? undefined,
    payload,
  });
  if (!verification.ok) {
    try { await paymentService.recordRejectedCallback({ ipAddress: req.ip, reason: verification.reason, payload }); } catch { /* rejection still fails closed */ }
    next(new BadRequestError('M-Pesa callback verification failed', undefined, 'MPESA_CALLBACK_UNVERIFIED'));
    return;
  }
  try {
    const result = await paymentService.processStkCallback(payload);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted', data: result });
  } catch (error) { next(error); }
}

export default { initiateStkPush, getPaymentStatus, mpesaCallback };
