import { z } from 'zod';

const money = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.string().uuid();

export const applyLoanSchema = z.object({
	chamaId: uuid,
	amount: money,
	purpose: z.string().trim().min(3).max(500).optional(),
	dueDate: z.string().date().optional(),
	guarantors: z.array(z.object({ memberId: uuid, guaranteedAmount: money })).min(1).max(20),
}).superRefine((value, context) => {
	const coverage = value.guarantors.reduce((total, guarantor) => total + guarantor.guaranteedAmount, 0);
	if (coverage < value.amount) {
		context.addIssue({ code: z.ZodIssueCode.custom, message: 'Guarantors must cover the full loan amount', path: ['guarantors'] });
	}
});

export const nominateGuarantorSchema = z.object({
	approved: z.literal(true),
});


export const rejectLoanSchema = z.object({
	reason: z.string().trim().min(3).max(1000).optional(),
});

export const repayLoanSchema = z.object({
	amount: money,
	paymentMethod: z.enum(['mpesa', 'bank', 'cash', 'card']),
	providerReference: z.string().trim().min(1).max(150).optional(),
	receiptNumber: z.string().trim().min(1).max(150).optional(),
});

export const upsertLoanRuleSchema = z.object({
	interestRate: z.coerce.number().min(0).max(100),
	maxBorrowingMultiplier: z.coerce.number().positive().max(100),
	minGuarantors: z.coerce.number().int().min(1).max(20).default(5),
	maxTermDays: z.coerce.number().int().positive().max(3650).optional(),
	interestCycleDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
});

export type ApplyLoanInput = z.infer<typeof applyLoanSchema>;
export type RejectLoanInput = z.infer<typeof rejectLoanSchema>;
export type RepayLoanInput = z.infer<typeof repayLoanSchema>;
export type UpsertLoanRuleInput = z.infer<typeof upsertLoanRuleSchema>;
