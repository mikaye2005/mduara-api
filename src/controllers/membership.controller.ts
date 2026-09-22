import type { NextFunction, Request, Response } from 'express';
import { commitmentService } from '../services/commitment.service';
import { chamaService } from '../services/chama.service';
import { membershipIdSchema } from '../validation/commitment.validation';
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

export default { getOwnCommitment, getOwnContributions, acceptConstitution, requestCommitmentRefund };
