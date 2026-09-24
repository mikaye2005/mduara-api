import type { NextFunction, Request, Response } from 'express';
import { commitmentService } from '../services/commitment.service';
import { chamaService } from '../services/chama.service';
import { membershipIdSchema } from '../validation/commitment.validation';
import { commitmentPaymentSchema } from '../validation/commitment.validation';
import { commitmentPaymentService } from '../services/commitment-payment.service';
import { verifyMpesaCallbackRequest } from '../services/payment.service';
import { BadRequestError } from '../utils/errors';
import { UnauthorizedError } from '../utils/errors';

export async function getOwnCommitment(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const membershipId = membershipIdSchema.parse(req.params.id);
    const data = await commitmentService.getOwnCommitment(membershipId, req.user.id);
    res.json({ data });
  } catch (error) { next(error); }
}

export async function getOwnContributions(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const membershipId = membershipIdSchema.parse(req.params.id);
    const data = await commitmentService.getOwnContributions(membershipId, req.user.id);
    res.json({ data });
  } catch (error) { next(error); }
}


export async function acceptConstitution(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const membershipId = membershipIdSchema.parse(req.params.id);
    const data = await chamaService.acceptCurrentConstitution(membershipId, req.user.id, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(data.replayed ? 200 : 201).json({ data });
  } catch (error) { next(error); }
}

export async function requestCommitmentRefund(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const membershipId = membershipIdSchema.parse(req.params.id);
    const data = await commitmentService.requestRefund(membershipId, req.user.id);
    res.status(202).json({ data });
  } catch (error) { next(error); }
}

export async function initiateCommitmentPayment(req: Request, res: Response, next: NextFunction) {
  try { if (!req.user?.id) throw new UnauthorizedError(); const input = commitmentPaymentSchema.parse(req.body); res.status(202).json({ data: await commitmentPaymentService.initiate(req.user.id, membershipIdSchema.parse(req.params.id), input.phoneNumber) }); } catch (error) { next(error); }
}

export async function commitmentMpesaCallback(req: Request, res: Response, next: NextFunction) {
  const verification = verifyMpesaCallbackRequest({ ipAddress: req.ip, signature: req.header('x-mduara-signature') ?? req.header('x-callback-signature') ?? undefined, payload: req.body });
  if (!verification.ok) { next(new BadRequestError('M-Pesa callback verification failed', undefined, 'MPESA_CALLBACK_UNVERIFIED')); return; }
  try { res.json({ ResultCode: 0, ResultDesc: 'Accepted', data: await commitmentPaymentService.processStkCallback(req.body) }); } catch (error) { next(error); }
}

export default { getOwnCommitment, getOwnContributions, acceptConstitution, requestCommitmentRefund, initiateCommitmentPayment, commitmentMpesaCallback };
