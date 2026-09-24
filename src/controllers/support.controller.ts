import type { NextFunction, Request, Response } from 'express';
import { supportService } from '../services/support.service';
import { createSupportTicketSchema, supportTicketListSchema, updateSupportTicketSchema } from '../validation/support.validation';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

export async function createTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = createSupportTicketSchema.parse(req.body);
    const ticket = await supportService.createTicket(req.user.id, input);
    res.status(201).json({ data: ticket });
  } catch (error) { next(error); }
}

export async function getTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const ticket = await supportService.getTicket(req.user.id, req.params.ticketId);
    res.json({ data: ticket });
  } catch (error) { next(error); }
}

export async function listUserTickets(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = supportTicketListSchema.parse(req.query);
    const userId = req.params.id;
    if (!userId) throw new ForbiddenError('User id is required', 'SUPPORT_USER_REQUIRED');
    const result = await supportService.listUserTickets(req.user.id, userId, {
      page: query.page,
      perPage: query.per_page,
      status: query.status,
      category: query.category,
    });
    res.json({ data: result.tickets, meta: result.meta });
  } catch (error) { next(error); }
}

export async function updateTicket(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = updateSupportTicketSchema.parse(req.body);
    const ticket = await supportService.updateTicket(req.user.id, req.params.ticketId, input);
    res.json({ data: ticket });
  } catch (error) { next(error); }
}

export default { createTicket, getTicket, listUserTickets, updateTicket };
