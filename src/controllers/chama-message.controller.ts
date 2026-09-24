import type { NextFunction, Request, Response } from 'express';
import { chamaMessageService } from '../services/chama-message.service';
import { createChamaMessageSchema, listChamaMessagesSchema } from '../validation/chama-message.validation';
import { UnauthorizedError } from '../utils/errors';

export async function listChamaMessages(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = listChamaMessagesSchema.parse(req.query);
    const result = await chamaMessageService.list(req.params.id, req.user.id, query.page, query.per_page);
    res.json({ data: result.messages, meta: result.meta });
  } catch (error) { next(error); }
}

export async function createChamaMessage(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const body = createChamaMessageSchema.parse(req.body);
    const message = await chamaMessageService.create({ chamaId: req.params.id, userId: req.user.id, ...body });
    res.status(201).json({ data: message });
  } catch (error) { next(error); }
}

export default { listChamaMessages, createChamaMessage };