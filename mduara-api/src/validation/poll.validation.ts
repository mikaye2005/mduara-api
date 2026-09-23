import { z } from 'zod';
import { constitutionRuleFieldsSchema } from './chama.validation';

const optionCodeSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/);
const decisionTypeSchema = z.enum(['general', 'rule_amendment', 'member_removal', 'dissolution', 'payout_order_dispute']);

const amendmentChangesSchema = constitutionRuleFieldsSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one Constitution field must change' },
);

export const createPollSchema = z.object({
  decisionType: decisionTypeSchema,
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  opensAt: z.string().datetime({ offset: true }).optional(),
  closesAt: z.string().datetime({ offset: true }),
  options: z.array(z.object({
    code: optionCodeSchema,
    label: z.string().trim().min(1).max(120),
  }).strict()).min(2).max(20),
  actionOptionCode: optionCodeSchema.nullable().optional(),
  decisionPayload: z.record(z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  const codes = value.options.map((option) => option.code);
  if (new Set(codes).size !== codes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Poll option codes must be unique' });
  }
  const labels = value.options.map((option) => option.label.toLocaleLowerCase());
  if (new Set(labels).size !== labels.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Poll option labels must be unique' });
  }
  if (value.actionOptionCode && !codes.includes(value.actionOptionCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actionOptionCode'], message: 'actionOptionCode must identify one of the poll options' });
  }
  if (value.decisionType !== 'general' && !value.actionOptionCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actionOptionCode'], message: 'Action polls require actionOptionCode' });
  }
  if (JSON.stringify(value.decisionPayload).length > 32_768) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decisionPayload'], message: 'decisionPayload is too large' });
  }
  if (value.decisionType === 'rule_amendment') {
    const parsed = z.object({
      amendment_summary: z.string().trim().min(3).max(2000),
      changes: amendmentChangesSchema,
    }).strict().safeParse(value.decisionPayload);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decisionPayload'], message: 'rule_amendment requires amendment_summary and validated changes' });
    }
  }
  if (value.decisionType === 'member_removal') {
    const parsed = z.object({ member_id: z.string().uuid(), reason: z.string().trim().max(2000).optional() }).strict().safeParse(value.decisionPayload);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decisionPayload'], message: 'member_removal requires member_id' });
    }
  }
});

export const votePollSchema = z.object({
  optionId: z.string().uuid().optional(),
  optionCode: optionCodeSchema.optional(),
}).strict().refine(
  (value) => Number(value.optionId !== undefined) + Number(value.optionCode !== undefined) === 1,
  { message: 'Provide exactly one of optionId or optionCode' },
);

export const pollIdSchema = z.string().uuid();

export const listPollsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['draft', 'open', 'closed', 'cancelled']).optional(),
});

export type CreatePollInput = z.infer<typeof createPollSchema>;
export type VotePollInput = z.infer<typeof votePollSchema>;
