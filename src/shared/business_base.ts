import type { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { ConflictError, NotFoundError } from '../utils/errors';

export type ConstitutionTemplateCode = 'custom' | 'savings' | 'goal_based' | 'merry_go_round' | 'investment';

export interface ConstitutionSetupParams {
	template_code?: ConstitutionTemplateCode;
	purpose_goal?: string;
	contribution_amount?: number;
	contribution_frequency?: string;
	contribution_due_day?: number | null;
	late_fine_type?: 'flat' | 'percentage';
	late_fine_amount?: number;
	late_fine_percentage?: number;
	default_grace_period_days?: number;
	default_after_consecutive_misses?: number;
	quorum_threshold_pct?: number;
	majority_threshold_pct?: number;
	exit_withdrawal_policy?: Record<string, unknown>;
	payout_policy?: Record<string, unknown>;
	conduct_dispute_policy?: Record<string, unknown>;
	dissolution_policy?: Record<string, unknown>;
}

export const CONSTITUTION_TEMPLATES: Record<ConstitutionTemplateCode, {
	code: ConstitutionTemplateCode;
	label: string;
	description: string;
	exit_withdrawal_policy: Record<string, unknown>;
	payout_policy: Record<string, unknown>;
	conduct_dispute_policy: Record<string, unknown>;
	dissolution_policy: Record<string, unknown>;
}> = {
	custom: {
		code: 'custom', label: 'Custom',
		description: 'Blank structured Constitution; the founder configures each policy explicitly.',
		exit_withdrawal_policy: {}, payout_policy: {}, conduct_dispute_policy: {},
		dissolution_policy: { requires_member_vote: true },
	},
	savings: {
		code: 'savings', label: 'Savings / Table Banking',
		description: 'Savings-oriented structure with Constitution-governed withdrawals and distributions.',
		exit_withdrawal_policy: { configured_by_chama: true },
		payout_policy: { configured_by_chama: true, settlement: 'provider_instruction' },
		conduct_dispute_policy: { requires_recorded_resolution: true },
		dissolution_policy: { requires_member_vote: true },
	},
	goal_based: {
		code: 'goal_based', label: 'Goal-based Saving',
		description: 'Goal-completion structure for Phase 1 goal-based Mbogis.',
		exit_withdrawal_policy: { configured_by_chama: true },
		payout_policy: { trigger: 'goal_completion', settlement: 'provider_instruction' },
		conduct_dispute_policy: { requires_recorded_resolution: true },
		dissolution_policy: { requires_member_vote: true },
	},
	merry_go_round: {
		code: 'merry_go_round', label: 'Merry-Go-Round',
		description: 'Rotating-payout structure backed by the cycle queue and provider-confirmed settlement.',
		exit_withdrawal_policy: { configured_by_chama: true },
		payout_policy: { mode: 'rotating_queue', settlement: 'provider_instruction' },
		conduct_dispute_policy: { requires_recorded_resolution: true },
		dissolution_policy: { requires_member_vote: true },
	},
	investment: {
		code: 'investment', label: 'Investment',
		description: 'Investment-oriented structure; distribution economics remain Chama-configured.',
		exit_withdrawal_policy: { configured_by_chama: true },
		payout_policy: { configured_by_chama: true, settlement: 'provider_instruction' },
		conduct_dispute_policy: { requires_recorded_resolution: true },
		dissolution_policy: { requires_member_vote: true },
	},
};

export function defaultConstitutionTemplateForChamaType(type: string): ConstitutionTemplateCode {
	switch (type) {
		case 'goal_based': return 'goal_based';
		case 'table_banking': return 'savings';
		case 'merry_go_round': return 'merry_go_round';
		case 'investment': return 'investment';
		default: return 'custom';
	}
}

export function mergeConstitutionTemplate(
	templateCode: ConstitutionTemplateCode,
	overrides: ConstitutionSetupParams = {},
) {
	const template = CONSTITUTION_TEMPLATES[templateCode];
	return {
		template_code: templateCode,
		exit_withdrawal_policy: { ...template.exit_withdrawal_policy, ...(overrides.exit_withdrawal_policy ?? {}) },
		payout_policy: { ...template.payout_policy, ...(overrides.payout_policy ?? {}) },
		conduct_dispute_policy: { ...template.conduct_dispute_policy, ...(overrides.conduct_dispute_policy ?? {}) },
		dissolution_policy: { ...template.dissolution_policy, ...(overrides.dissolution_policy ?? {}) },
	};
}

export interface CreateChamaParams {
	name: string;
	description?: string;
	type: string;
	contribution_amount: number;
	contribution_frequency: string;
	meeting_schedule?: string;
	target_amount?: number | null;
	visibility?: 'public' | 'application' | 'private';
	goal_code?: string | null;
	location?: string | null;
	target_members?: number | null;
	recruitment_deadline?: string | null;
	saving_start_date?: string | null;
	saving_end_date?: string | null;
	purchase_window_start?: string | null;
	purchase_window_end?: string | null;
	created_by?: string | null;
	constitution_template?: ConstitutionTemplateCode;
	constitution?: ConstitutionSetupParams;
}


export interface UpdateChamaParams {
	chamaId: string;
	updates: {
		name?: string;
		description?: string | null;
		visibility?: 'public' | 'application' | 'private';
		goal_code?: string | null;
		location?: string | null;
			target_members?: number | null;
		recruitment_deadline?: string | null;
		saving_start_date?: string | null;
		saving_end_date?: string | null;
		purchase_window_start?: string | null;
		purchase_window_end?: string | null;
		meeting_schedule?: string | null;
	};
}

export interface InviteApplicantParams {
	chamaId: string;
	applicantId?: string;
	requestedRole?: string;
	message?: string;
	phone?: string;
	expiresAt?: string | null;
	maxUses?: number;
	shareable?: boolean;
}

export interface ListMembersParams {
	chamaId: string;
	limit?: number;
	offset?: number;
	role?: string;
	status?: string;
}

export interface UpdateChamaMemberParams {
	chamaId: string;
	userId: string;
	updates: {
		role?: string;
		membership_status?: string;
	};
	actorId?: string;
	actorIp?: string;
	actorUserAgent?: string;
}

export abstract class BusinessBase {
	constructor(protected readonly db: Pool = pool) {}

	protected async transaction<T>(work: Parameters<typeof withDatabaseTransaction<T>>[0]): Promise<T> {
		return withDatabaseTransaction(work, {}, this.db);
	}
}

export class ChamaBusinessBase extends BusinessBase {
	async createChama(params: CreateChamaParams) {
		if (!params.created_by) {
			throw new Error('Authenticated founder is required to create a Chama');
		}

		return this.transaction(async (client) => {
			const result = await client.query(
				`INSERT INTO chamas (
				   name, description, type, contribution_amount, contribution_frequency,
				   meeting_schedule, target_amount, visibility, goal_code, location,
				   target_members, recruitment_deadline, saving_start_date, saving_end_date,
				   purchase_window_start, purchase_window_end, created_by
				 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
				 RETURNING *`,
				[
					params.name,
					params.description ?? null,
					params.type,
					params.contribution_amount,
					params.contribution_frequency,
					params.meeting_schedule ?? null,
					params.target_amount ?? null,
					params.visibility ?? 'application',
					params.goal_code ?? null,
					params.location ?? null,
					params.target_members ?? null,
					params.recruitment_deadline ?? null,
					params.saving_start_date ?? null,
					params.saving_end_date ?? null,
					params.purchase_window_start ?? null,
					params.purchase_window_end ?? null,
					params.created_by,
				],
			);

			const chama = result.rows[0];

			await client.query(
				`INSERT INTO chama_members (
				   chama_id, user_id, role, membership_status, approved_by, approved_at, joined_at
				 ) VALUES ($1, $2, 'chairperson', 'active', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
				[chama.id, params.created_by],
			);

			// Every join path requires an active Constitution. Seed version 1 atomically
			// from a standard structural template plus any explicit founder overrides.
			// Commitment amount intentionally stays at the canonical KSh 500 default while
			// PD-19 (fixed vs configurable commitment) remains unresolved.
			const constitutionOverrides = params.constitution ?? {};
			const templateCode = params.constitution_template
				?? constitutionOverrides.template_code
				?? defaultConstitutionTemplateForChamaType(params.type);
			const template = mergeConstitutionTemplate(templateCode, constitutionOverrides);
			await client.query(
				`INSERT INTO chama_rules (
				   chama_id, version, status, template_code, purpose_goal,
				   contribution_amount, contribution_frequency, contribution_due_day,
				   late_fine_type, late_fine_amount, late_fine_percentage,
				   default_grace_period_days, default_after_consecutive_misses,
				   quorum_threshold_pct, majority_threshold_pct,
				   exit_withdrawal_policy, payout_policy, conduct_dispute_policy,
				   dissolution_policy, metadata, created_by, effective_from
				 ) VALUES (
				   $1, 1, 'active', $2, $3, $4, $5, $6,
				   $7, $8, $9, $10, $11, $12, $13,
				   $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb,
				   $19, CURRENT_TIMESTAMP
				 )`,
				[
					chama.id,
					template.template_code,
					(constitutionOverrides.purpose_goal ?? params.description?.trim()) || params.name,
					constitutionOverrides.contribution_amount ?? params.contribution_amount,
					constitutionOverrides.contribution_frequency ?? params.contribution_frequency,
					constitutionOverrides.contribution_due_day ?? null,
					constitutionOverrides.late_fine_type ?? 'flat',
					constitutionOverrides.late_fine_amount ?? 0,
					constitutionOverrides.late_fine_percentage ?? 0,
					constitutionOverrides.default_grace_period_days ?? 0,
					constitutionOverrides.default_after_consecutive_misses ?? 3,
					constitutionOverrides.quorum_threshold_pct ?? 50,
					constitutionOverrides.majority_threshold_pct ?? 50,
					JSON.stringify(template.exit_withdrawal_policy),
					JSON.stringify(template.payout_policy),
					JSON.stringify(template.conduct_dispute_policy),
					JSON.stringify(template.dissolution_policy),
					JSON.stringify({ templateCode: template.template_code, templateVersion: 1 }),
					params.created_by,
				],
			);

			// Keep the Chama-level contribution contract aligned with the Constitution.
			if (constitutionOverrides.contribution_amount !== undefined || constitutionOverrides.contribution_frequency !== undefined) {
				await client.query(
					`UPDATE chamas SET contribution_amount = $2, contribution_frequency = $3 WHERE id = $1`,
					[chama.id, constitutionOverrides.contribution_amount ?? params.contribution_amount,
					 constitutionOverrides.contribution_frequency ?? params.contribution_frequency],
				);
			}

			return chama;
		});
	}


	async getChamaById(chamaId: string) {
		const result = await this.db.query(
			`SELECT c.*,
			        COUNT(cm.id) FILTER (WHERE cm.membership_status = 'active')::int AS active_member_count
			 FROM chamas c
			 LEFT JOIN chama_members cm ON cm.chama_id = c.id
			 WHERE c.id = $1
			 GROUP BY c.id`,
			[chamaId],
		);

		if (!result.rows[0]) {
			throw new Error('Chama not found');
		}

		return result.rows[0];
	}

	async updateChama({ chamaId, updates }: UpdateChamaParams) {
		const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
		if (entries.length === 0) {
			return this.getChamaById(chamaId);
		}

		const allowed = new Set([
			'name',
			'description',
			'visibility',
			'goal_code',
			'location',
			'target_members',
			'recruitment_deadline',
			'saving_start_date',
			'saving_end_date',
			'purchase_window_start',
			'purchase_window_end',
			'meeting_schedule',
		]);

		for (const [field] of entries) {
			if (!allowed.has(field)) throw new Error(`Unsupported Chama update field: ${field}`);
		}

		const values: unknown[] = [];
		const assignments = entries.map(([field, value], index) => {
			values.push(value);
			return `${field} = $${index + 1}`;
		});
		values.push(chamaId);

		const result = await this.db.query(
			`UPDATE chamas
			 SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
			 WHERE id = $${values.length}
			 RETURNING *`,
			values,
		);

		if (!result.rows[0]) {
			throw new Error('Chama not found');
		}

		return result.rows[0];
	}

	async inviteApplicant({
		chamaId,
		applicantId,
		requestedRole,
		message,
		phone,
		expiresAt,
		maxUses = 1,
		shareable = false,
	}: InviteApplicantParams) {
		if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
			throw new ConflictError('Invitation max uses must be between 1 and 100', 'CHAMA_INVITATION_MAX_USES_INVALID');
		}
		if (!shareable && !applicantId && !phone) {
			throw new ConflictError('A targeted recipient or shareable invite is required', 'CHAMA_INVITATION_RECIPIENT_REQUIRED');
		}
		if (shareable && requestedRole && requestedRole !== 'member') {
			throw new ConflictError('Shareable invite links can only grant base membership', 'CHAMA_INVITATION_SHAREABLE_ROLE_FORBIDDEN');
		}

		const inviteToken = randomBytes(24).toString('base64url');
		const inviteTokenHash = createHash('sha256').update(inviteToken).digest('hex');

		return this.transaction(async (client) => {
			const chamaRes = await client.query(
				`SELECT id, name, status::text AS status, visibility::text AS visibility,
				        target_members, recruitment_deadline, recruitment_closed_at,
				        (recruitment_deadline IS NOT NULL AND recruitment_deadline < CURRENT_DATE) AS deadline_passed
				 FROM chamas WHERE id = $1 FOR UPDATE`,
				[chamaId],
			);
			const chama = chamaRes.rows[0];
			if (!chama) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');
			if (!['recruiting', 'active'].includes(chama.status)
				|| chama.recruitment_closed_at
				|| chama.deadline_passed) {
				throw new ConflictError('Chama recruitment is closed', 'CHAMA_RECRUITMENT_CLOSED');
			}
			if (shareable && chama.visibility !== 'private') {
				throw new ConflictError('Shareable invite links are reserved for Private Chamas', 'CHAMA_SHAREABLE_INVITE_PRIVATE_ONLY');
			}

			if (applicantId) {
				const existingMembership = (await client.query(
					`SELECT id FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
					[chamaId, applicantId],
				)).rows[0];
				if (existingMembership) {
					throw new ConflictError('User already has a membership for this Chama', 'CHAMA_MEMBERSHIP_EXISTS');
				}
			}

			if (!shareable) {
				const existingInvite = (await client.query(
					`SELECT id FROM chama_invitations
					 WHERE chama_id = $1
					   AND (($2::uuid IS NOT NULL AND applicant_id = $2::uuid)
					        OR ($3::text IS NOT NULL AND recipient_phone = $3::text))
					   AND status IN ('pending', 'sent', 'approved', 'delivery_failed')
					   AND use_count < max_uses
					   AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
					 LIMIT 1`,
					[chamaId, applicantId ?? null, phone ?? null],
				)).rows[0];
				if (existingInvite) {
					throw new ConflictError('An active invitation already exists for this user', 'CHAMA_INVITATION_EXISTS');
				}
			}

			const countRes = await client.query(
				`SELECT COUNT(*)::int AS cnt
				 FROM chama_members
				 WHERE chama_id = $1 AND membership_status IN ('active','pending')`,
				[chamaId],
			);
			const current = Number(countRes.rows[0]?.cnt ?? 0);
			const capacity = chama.target_members === null
				? env.CHAMA_MAX_MEMBERS
				: Math.min(Number(chama.target_members), env.CHAMA_MAX_MEMBERS);
			if (current >= capacity) {
				throw new ConflictError('Chama has reached its member capacity', 'CHAMA_CAPACITY_REACHED');
			}

			const invRes = await client.query(
				`INSERT INTO chama_invitations
				   (chama_id, applicant_id, recipient_phone, invite_token_hash,
				    requested_role, message, max_uses, expires_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, CURRENT_TIMESTAMP + INTERVAL '7 days'))
				 RETURNING *`,
				[
					chamaId,
					applicantId ?? null,
					phone ?? null,
					inviteTokenHash,
					requestedRole ?? 'member',
					message ?? null,
					maxUses,
					expiresAt ?? null,
				],
			);

			const row = invRes.rows[0];
			return {
				// Preserve the historical service shape without exposing invite_token_hash.
				invitation: {
					id: row.id,
					chama_id: row.chama_id,
					applicant_id: row.applicant_id,
					recipient_phone: row.recipient_phone,
					recipient_email: row.recipient_email,
					requested_role: row.requested_role,
					message: row.message,
					status: row.status,
					max_uses: row.max_uses,
					use_count: row.use_count,
					expires_at: row.expires_at,
					created_at: row.created_at,
				},
				chama,
				inviteToken,
			};
		});
	}

	async listMembers({ chamaId, limit = 25, offset = 0, role, status }: ListMembersParams) {
		const where: string[] = ['cm.chama_id = $1'];
		const values: unknown[] = [chamaId];
		let idx = 2;

		if (role) {
			where.push(`cm.role = $${idx++}`);
			values.push(role);
		}

		if (status) {
			where.push(`cm.membership_status = $${idx++}`);
			values.push(status);
		}

		const totalRes = await this.db.query(`SELECT COUNT(*)::int AS cnt FROM chama_members cm WHERE ${where.join(' AND ')}`, values);
		const total = Number(totalRes.rows[0]?.cnt ?? 0);

		values.push(limit);
		values.push(offset);

		const rows = await this.db.query(
			`SELECT cm.id, cm.user_id, cm.role::text AS role,
			        cm.membership_status::text AS membership_status,
			        cm.joined_at::text AS joined_at,
			        cm.commitment_status::text AS commitment_status,
			        cm.commitment_status_updated_at::text AS commitment_status_updated_at,
			        u.full_name, u.avatar_url,
			        CASE WHEN u.status = 'active' THEN 'VERIFIED' ELSE 'UNVERIFIED' END AS verification_badge
			 FROM chama_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE ${where.join(' AND ')}
			 ORDER BY cm.joined_at DESC
			 LIMIT $${idx++} OFFSET $${idx++}`,
			values,
		);

		return { total, members: rows.rows };
	}

	async updateMember({ chamaId, userId, updates, actorId, actorIp, actorUserAgent }: UpdateChamaMemberParams) {
		return this.transaction(async (client) => {
			const mRes = await client.query(
				`SELECT id, role::text AS role, membership_status::text AS membership_status, exit_date
				 FROM chama_members
				 WHERE chama_id = $1 AND user_id = $2
				 FOR UPDATE`,
				[chamaId, userId],
			);
			const member = mRes.rows[0];
			if (!member) throw new NotFoundError('Membership not found', 'CHAMA_MEMBERSHIP_NOT_FOUND');

			const nextRole = updates.role ?? member.role;
			const nextStatus = updates.membership_status ?? member.membership_status;
			const removesActiveChair = member.role === 'chairperson'
				&& member.membership_status === 'active'
				&& (nextRole !== 'chairperson' || nextStatus !== 'active');

			if (removesActiveChair) {
				const otherChairCount = Number((await client.query(
					`SELECT COUNT(*)::int AS count
					 FROM chama_members
					 WHERE chama_id = $1
					   AND user_id <> $2
					   AND role = 'chairperson'
					   AND membership_status = 'active'`,
					[chamaId, userId],
				)).rows[0]?.count ?? 0);
				if (otherChairCount === 0) {
					throw new ConflictError(
						'Assign another active chairperson before removing or demoting the current chairperson',
						'LAST_ACTIVE_CHAIRPERSON',
					);
				}
			}

			const fields: string[] = [];
			const values: unknown[] = [];
			let idx = 1;

			if (updates.role !== undefined) {
				fields.push(`role = $${idx++}::member_role`);
				values.push(updates.role);
			}

			if (updates.membership_status !== undefined) {
				fields.push(`membership_status = $${idx++}::membership_status`);
				values.push(updates.membership_status);
				if (updates.membership_status === 'active') {
					fields.push(`approved_by = $${idx++}`);
					values.push(actorId ?? null);
					fields.push('approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)');
					fields.push('exit_date = NULL');
				} else if (updates.membership_status === 'exited') {
					fields.push('exit_date = COALESCE(exit_date, CURRENT_TIMESTAMP)');
				} else if (member.membership_status === 'exited') {
					fields.push('exit_date = NULL');
				}
			}

			if (fields.length === 0) return member;
			fields.push('updated_at = CURRENT_TIMESTAMP');

			values.push(chamaId);
			values.push(userId);
			const query = `UPDATE chama_members
			               SET ${fields.join(', ')}
			               WHERE chama_id = $${idx++} AND user_id = $${idx++}
			               RETURNING *`;
			const updated = await client.query(query, values);
			const updatedRow = updated.rows[0];

			if (actorId) {
				const actor = (await client.query(
					`SELECT role::text AS role FROM chama_members
					 WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
					[chamaId, actorId],
				)).rows[0];
				await client.query(
					`INSERT INTO audit_logs
					   (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, ip_address, user_agent, payload)
					 VALUES ('moderation','chama.member_updated',$1,$2::audit_actor_role,$3,'chama_member',$4,$5::inet,$6,$7::jsonb)`,
					[
						actorId,
						actor?.role ?? null,
						chamaId,
						updatedRow.id,
						actorIp?.startsWith('::ffff:') ? actorIp.slice(7) : (actorIp ?? null),
						actorUserAgent?.slice(0, 1024) ?? null,
						JSON.stringify({
							userId,
							before: { role: member.role, membershipStatus: member.membership_status },
							after: { role: updatedRow.role, membershipStatus: updatedRow.membership_status },
						}),
					],
				);
			}

			return updatedRow;
		});
	}

}
