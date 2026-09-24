import type { NextFunction, Request, Response } from 'express';
import { meetingService } from '../services/meeting.service';
import {
  attendanceHistoryQuerySchema,
  createMeetingSchema,
  meetingListQuerySchema,
  meetingRsvpSchema,
  recordAttendanceSchema,
} from '../validation/meeting.validation';
import { UnauthorizedError } from '../utils/errors';

export async function createMeeting(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = createMeetingSchema.parse(req.body);
    const meeting = await meetingService.createMeeting(req.user.id, req.params.id, input);
    res.status(201).json({ data: meeting });
  } catch (error) { next(error); }
}

export async function listMeetings(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = meetingListQuerySchema.parse(req.query);
    const result = await meetingService.listMeetings(req.user.id, req.params.id, {
      page: query.page, perPage: query.per_page, from: query.from, to: query.to,
    });
    res.json({ data: result.meetings, meta: result.meta });
  } catch (error) { next(error); }
}

export async function rsvp(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = meetingRsvpSchema.parse(req.body);
    const result = await meetingService.rsvp(req.user.id, req.params.meetingId, input);
    res.json({ data: result });
  } catch (error) { next(error); }
}

export async function recordAttendance(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = recordAttendanceSchema.parse(req.body);
    const result = await meetingService.recordAttendance(req.user.id, req.params.meetingId, input);
    res.json({ data: result });
  } catch (error) { next(error); }
}

export async function attendanceHistory(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const query = attendanceHistoryQuerySchema.parse(req.query);
    const result = await meetingService.attendanceHistory(req.user.id, req.params.id, {
      from: query.from, to: query.to, memberId: query.member_id,
      page: query.page, perPage: query.per_page,
    });
    res.json({ data: result.attendance, meta: result.meta });
  } catch (error) { next(error); }
}

export default { createMeeting, listMeetings, rsvp, recordAttendance, attendanceHistory };
