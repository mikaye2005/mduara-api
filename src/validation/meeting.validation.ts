import { z } from 'zod';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const offsetDateTimeSchema = z.string().datetime({ offset: true });

export const createMeetingSchema = z.object({
  title: z.string().trim().min(3).max(180),
  startsAt: offsetDateTimeSchema,
  location: z.string().trim().min(2).max(500).nullable().optional(),
  meetingUrl: z.string().trim().url().max(2048).nullable().optional(),
  agenda: z.string().trim().max(10_000).nullable().optional(),
  reminderAt: offsetDateTimeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.location && !value.meetingUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['location'], message: 'Provide a physical location or meetingUrl' });
  }
  if (value.reminderAt && new Date(value.reminderAt) >= new Date(value.startsAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reminderAt'], message: 'reminderAt must be before startsAt' });
  }
});

export const meetingListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be on or after from' });
  }
});

export const attendanceHistoryQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  member_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
}).superRefine((value, ctx) => {
  if (value.from > value.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to must be on or after from' });
    return;
  }
  const days = Math.round((Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000);
  if (days > 366) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'Attendance range cannot exceed 366 days' });
});

export const meetingRsvpSchema = z.object({
  status: z.enum(['going', 'maybe', 'declined']),
}).strict();

export const recordAttendanceSchema = z.object({
  memberId: z.string().uuid(),
  present: z.boolean(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type MeetingRsvpInput = z.infer<typeof meetingRsvpSchema>;
export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>;
