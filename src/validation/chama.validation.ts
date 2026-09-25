import { z } from 'zod';
import { DATABASE_CHAMA_ROLES } from '../shared/chama-roles';
import { chamaCycleFieldsSchema } from './public-chama.validation';

const chamaRoleSchema = z.enum(DATABASE_CHAMA_ROLES);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const constitutionTemplateCodeSchema = z.enum(['custom', 'savings', 'goal_based', 'merry_go_round', 'investment']);
const chamaTypeSchema = z.enum(['goal_based', 'table_banking', 'merry_go_round', 'welfare', 'investment']);
const jsonPolicySchema = z.record(z.unknown());

export const constitutionRuleFieldsSchema = z.object({
  template_code: constitutionTemplateCodeSchema.optional(),
  purpose_goal: z.string().trim().min(1).max(2000).optional(),
  contribution_amount: z.coerce.number().int().positive().optional(),
  contribution_frequency: z.string().trim().min(1).max(100).optional(),
  contribution_due_day: z.coerce.number().int().min(1).max(31).nullable().optional(),
  late_fine_type: z.enum(['flat', 'percentage']).optional(),
  late_fine_amount: z.coerce.number().int().min(0).optional(),
  late_fine_percentage: z.coerce.number().min(0).max(100).optional(),
  default_grace_period_days: z.coerce.number().int().min(0).optional(),
  default_after_consecutive_misses: z.coerce.number().int().min(1).max(12).optional(),
  quorum_threshold_pct: z.coerce.number().min(0).max(100).optional(),
  majority_threshold_pct: z.coerce.number().gt(0).max(100).optional(),
  exit_withdrawal_policy: jsonPolicySchema.optional(),
  payout_policy: jsonPolicySchema.optional(),
  conduct_dispute_policy: jsonPolicySchema.optional(),
  dissolution_policy: jsonPolicySchema.optional(),
}).strict();

export const constitutionSetupSchema = constitutionRuleFieldsSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one Constitution field must be provided' },
);

export const constitutionAmendSchema = constitutionRuleFieldsSchema.extend({
  poll_id: z.string().uuid(),
  amendment_summary: z.string().trim().min(3).max(2000),
}).refine(
  (value) => Object.keys(value).some((key) => !['poll_id', 'amendment_summary'].includes(key)),
  { message: 'At least one Constitution field must change in an amendment' },
);

export const createChamaSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  type: chamaTypeSchema,
  goal_code: z.string().trim().min(1).max(100).optional().nullable(),
  contribution_amount: z.coerce.number().int().positive(),
  contribution_frequency: z.string().min(1),
  target_members: z.coerce.number().int().min(2),
  recruitment_deadline: isoDateSchema,
  saving_start_date: isoDateSchema,
  saving_end_date: isoDateSchema,
  visibility: z.enum(['public', 'application', 'private']),
  constitution: constitutionSetupSchema,
  phone_number: z.string().trim().min(9).max(20),
  meeting_schedule: z.string().optional(),
  target_amount: z.coerce.number().int().positive().optional().nullable(),
  constitution_template: constitutionTemplateCodeSchema.optional(),
}).merge(chamaCycleFieldsSchema).superRefine((value, ctx) => {
  for (const field of ['target_members', 'recruitment_deadline', 'saving_start_date', 'saving_end_date', 'visibility'] as const) {
    if (value[field] === undefined || value[field] === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required when starting a Chama` });
    }
  }
  if (value.type === 'goal_based' && !value.goal_code) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['goal_code'], message: 'goal_code is required for a goal-based Chama' });
  }
  if (value.saving_start_date && value.saving_end_date && value.saving_end_date < value.saving_start_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['saving_end_date'], message: 'saving_end_date cannot precede saving_start_date' });
  }
  if (value.purchase_window_start && value.purchase_window_end && value.purchase_window_end < value.purchase_window_start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purchase_window_end'], message: 'purchase_window_end cannot precede purchase_window_start' });
  }
  if (value.constitution_template && value.constitution?.template_code
      && value.constitution_template !== value.constitution.template_code) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['constitution_template'], message: 'constitution_template must match constitution.template_code when both are provided' });
  }
});

const wizardConstitutionSectionsSchema = z.object({
  commitmentAndDefault: z.string().trim().min(20),
  contributionRules: z.string().trim().min(20),
  dissolution: z.string().trim().min(20),
  exitAndWithdrawal: z.string().trim().min(20),
  memberConductAndDisputes: z.string().trim().min(20),
  payoutRules: z.string().trim().min(20),
  purposeAndGoal: z.string().trim().min(20),
  votingAndDecisions: z.string().trim().min(20),
}).strict();

/** Compatibility contract used by the current Start Chama wizard. */
export const createChamaWizardSchema = z.object({
  autoCloseRecruitment: z.boolean(),
  constitution: z.object({
    sections: wizardConstitutionSectionsSchema,
    version: z.literal(1),
  }).strict(),
  contributionAmount: z.coerce.number().int().positive(),
  contributionFrequency: z.enum(['weekly', 'biweekly', 'monthly']),
  contributionStartDate: isoDateSchema,
  creationSource: z.enum(['self_service', 'platform_admin']),
  description: z.string().trim().max(2000).optional(),
  durationMonths: z.coerce.number().int().positive().max(120),
  founderIdentifier: z.string().trim().min(1).optional(),
  goalCode: z.string().trim().min(1).max(100).optional(),
  joiningWindowEndsAt: isoDateSchema,
  location: z.string().trim().max(255).optional(),
  logoUrl: z.string().trim().url().optional(),
  name: z.string().trim().min(3).max(255),
  purpose: z.string().trim().min(1).max(2000),
  recruitmentMode: z.enum(['public', 'application', 'private']),
  setupPaymentMode: z.enum(['mpesa', 'deferred']),
  targetAmount: z.coerce.number().int().positive(),
  targetMembers: z.coerce.number().int().min(2),
  type: z.enum(['savings', 'goal_based', 'merry_go_round', 'investment']),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'goal_based' && !value.goalCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['goalCode'], message: 'Choose a configured saving goal' });
  }
  if (value.contributionAmount > value.targetAmount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contributionAmount'], message: 'Contribution amount cannot exceed target amount' });
  }
  if (value.creationSource === 'platform_admin' && !value.founderIdentifier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['founderIdentifier'], message: 'Founder identifier is required for platform provisioning' });
  }
});

export const createChamaFrontendSchema = z.object({
  contribution_amount: z.coerce.number().int().positive(),
  contribution_frequency: z.string().trim().min(1).max(100),
  description: z.string().optional(),
  duration_months: z.coerce.number().int().positive().max(120),
  goal_code: z.string().trim().min(1).max(100),
  joining_window_ends_at: isoDateSchema.optional(),
  location: z.string().trim().max(255).optional(),
  name: z.string().trim().min(3),
  recruitment_mode: z.enum(['open', 'closed']),
  rules: z.string().trim().min(24),
  target_amount: z.coerce.number().int().positive(),
  target_members: z.coerce.number().int().min(2),
  type: z.literal('goal_based_saving'),
  visibility: z.enum(['public', 'application']).optional(),
}).superRefine((value, ctx) => {
  const expectedVisibility = value.recruitment_mode === 'open' ? 'public' : 'application';
  if (value.visibility && value.visibility !== expectedVisibility) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['visibility'],
      message: `visibility must be ${expectedVisibility} for this recruitment mode`,
    });
  }
  if (value.contribution_amount > value.target_amount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['contribution_amount'],
      message: 'contribution_amount cannot exceed target_amount',
    });
  }
});

export const updateChamaSchema = z.object({
  name: z.string().min(3).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  visibility: z.enum(['public', 'application', 'private']).optional(),
  goal_code: z.string().trim().min(1).nullable().optional(),
  location: z.string().trim().max(255).nullable().optional(),
  target_members: z.coerce.number().int().min(2).nullable().optional(),
  recruitment_deadline: isoDateSchema.nullable().optional(),
  saving_start_date: isoDateSchema.nullable().optional(),
  saving_end_date: isoDateSchema.nullable().optional(),
  purchase_window_start: isoDateSchema.nullable().optional(),
  purchase_window_end: isoDateSchema.nullable().optional(),
  meeting_schedule: z.string().trim().max(500).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.saving_start_date && value.saving_end_date && value.saving_end_date < value.saving_start_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['saving_end_date'], message: 'saving_end_date cannot precede saving_start_date' });
  }
  if (value.purchase_window_start && value.purchase_window_end && value.purchase_window_end < value.purchase_window_start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purchase_window_end'], message: 'purchase_window_end cannot precede purchase_window_start' });
  }
}).refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: 'At least one Chama field must be provided' },
);

export const inviteSchema = z.object({
  applicant_user_id: z.string().uuid().optional(),
  phone: z.string().trim().min(7).max(32).optional(),
  requested_role: chamaRoleSchema.optional(),
  message: z.string().trim().max(1000).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  max_uses: z.coerce.number().int().min(1).max(100).default(1),
  shareable: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (!value.shareable && !value.applicant_user_id && !value.phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['shareable'],
      message: 'Provide a recipient or set shareable=true',
    });
  }
  if (value.shareable && value.requested_role && value.requested_role !== 'member') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requested_role'],
      message: 'Shareable invites can only grant member role',
    });
  }
});

export const listInvitationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'sent', 'approved', 'accepted', 'rejected', 'cancelled', 'expired', 'delivery_failed']).optional(),
});

export const listMembersSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(200).optional(),
  role: chamaRoleSchema.optional(),
  status: z.enum(['active', 'pending', 'suspended', 'defaulted', 'exited']).optional(),
});


export const listApplicationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'commitment_pending', 'approved', 'rejected', 'withdrawn']).optional(),
});

export const applicationIdSchema = z.string().uuid();

export const reviewApplicationSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  rejection_reason: z.string().trim().min(3).max(1000).optional(),
}).superRefine((value, ctx) => {
  if (value.decision === 'reject' && !value.rejection_reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rejection_reason'],
      message: 'rejection_reason is required when rejecting an application',
    });
  }
  if (value.decision === 'approve' && value.rejection_reason !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rejection_reason'],
      message: 'rejection_reason is only valid for a rejected application',
    });
  }
});

export const updateMemberSchema = z.object({
  role: chamaRoleSchema.optional(),
  membership_status: z.enum(['active', 'pending', 'suspended', 'defaulted', 'exited']).optional(),
}).refine(
  (value) => value.role !== undefined || value.membership_status !== undefined,
  { message: 'At least one membership field must be provided' },
);

export type CreateChamaInput = z.infer<typeof createChamaSchema>;
export type ConstitutionSetupInput = z.infer<typeof constitutionSetupSchema>;
export type ConstitutionAmendInput = z.infer<typeof constitutionAmendSchema>;
export type UpdateChamaInput = z.infer<typeof updateChamaSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type ListInvitationsInput = z.infer<typeof listInvitationsSchema>;
export type ListMembersInput = z.infer<typeof listMembersSchema>;
export type ListApplicationsInput = z.infer<typeof listApplicationsSchema>;
export type ReviewApplicationInput = z.infer<typeof reviewApplicationSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
