import type { NextFunction, Request, Response } from 'express';
import { pollService } from '../services/poll.service';
import { createPollSchema, listPollsQuerySchema, pollIdSchema, votePollSchema } from '../validation/poll.validation';
import { UnauthorizedError } from '../utils/errors';

export async function createPoll(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = createPollSchema.parse(req.body);
    const data = await pollService.createPoll(req.user.id, req.params.id, input);
    res.status(201).json({ data });
  } catch (error) { next(error); }
}

export async function listChamaPolls(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = listPollsQuerySchema.parse(req.query);
    const result = await pollService.listForChama(req.user.id, req.params.id, {
      page: query.page,
      perPage: query.per_page,
      status: query.status,
    });
    res.json({ data: result.polls, meta: result.meta });
  } catch (error) { next(error); }
}

export async function vote(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const pollId = pollIdSchema.parse(req.params.pollId);
    const input = votePollSchema.parse(req.body);
    const data = await pollService.vote(req.user.id, pollId, input);
    res.status(201).json({ data });
  } catch (error) { next(error); }
}

export async function actOutcome(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const pollId = pollIdSchema.parse(req.params.pollId);
    const data = await pollService.actOutcome(req.user.id, pollId);
    res.json({ data });
  } catch (error) { next(error); }
}

export async function results(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const pollId = pollIdSchema.parse(req.params.pollId);
    const data = await pollService.getResults(req.user.id, pollId);
    res.json({ data });
  } catch (error) { next(error); }
}

export default { createPoll, listChamaPolls, vote, actOutcome, results };
