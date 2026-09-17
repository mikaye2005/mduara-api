import type { NextFunction, Request, Response } from 'express';
import { memberSummaryService } from '../services/member-summary.service';
import { userProfileService } from '../services/user-profile.service';
import { memberSummaryQuerySchema } from '../validation/member-summary.validation';
import { updateMyProfileSchema } from '../validation/user.validation';
import { UnauthorizedError } from '../utils/errors';

export async function getMyMemberSummary(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();

    const query = memberSummaryQuerySchema.parse({
      page: req.query.page,
      per_page: req.query.per_page,
    });

    const summary = await memberSummaryService.getSummary(req.user.id, {
      page: query.page,
      perPage: query.per_page,
    });

    res.json({ data: summary });
  } catch (error) {
    next(error);
  }
}


export async function updateMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const payload = updateMyProfileSchema.parse(req.body);
    const profile = await userProfileService.updateOwnProfile(req.user.id, payload);
    res.json({ data: profile });
  } catch (error) {
    next(error);
  }
}

export default { getMyMemberSummary, updateMyProfile };
