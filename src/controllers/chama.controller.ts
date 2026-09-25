import type { Request, Response, NextFunction } from 'express';
import { chamaService } from '../services/chama.service';
import { chamaApplicationService } from '../services/chama-application.service';
import { chamaInvitationService } from '../services/chama-invitation.service';
import { publicChamaService } from '../services/public-chama.service';
import { smsService } from '../services/sms.service';
import { notificationService } from '../services/notification.service';
import { env } from '../config/env';
import { pool } from '../db/client';
import { chamaRegistrationService } from '../services/chama-registration.service';
import { writeAuditEvent } from '../services/audit.service';
import type { CreateChamaParams } from '../shared/business_base';
import { applicationIdSchema, constitutionAmendSchema, constitutionSetupSchema, createChamaFrontendSchema, createChamaSchema, createChamaWizardSchema, inviteSchema, listApplicationsSchema, listInvitationsSchema, listMembersSchema, reviewApplicationSchema, updateChamaSchema, updateMemberSchema } from '../validation/chama.validation';
import { publicChamaApplySchema, publicChamaListSchema } from '../validation/public-chama.validation';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';


async function notifyApplicationApproved(result: any): Promise<void> {
  if (!result || result.outcome === 'rejected') return;
  const userId = result.application?.user_id;
  const chamaId = result.application?.chama_id;
  const applicationId = result.application?.id;
  if (!userId || !chamaId || !applicationId) return;
  const chama = await chamaService.getChamaById(chamaId).catch(() => null);
  await notificationService.dispatchBestEffort({
    userIds: [userId],
    chamaId,
    template: 'application_approved',
    data: {
      chamaName: chama?.name ?? 'your Chama',
      nextStep: result.outcome === 'commitment_required'
        ? 'Pay the required commitment deposit to activate your membership.'
        : 'Your membership is now active.',
    },
    dedupeKey: `application-approved:${applicationId}`,
  });
}

export async function createChama(req: Request, res: Response, next: NextFunction) {
	try {
		if (!req.user?.id) throw new UnauthorizedError();
    const wizardPayload = createChamaWizardSchema.safeParse(req.body);
    const frontendPayload = createChamaFrontendSchema.safeParse(req.body);
    let phoneNumber: string;
    let founderId = req.user.id;
    let creation: CreateChamaParams;
    let wizardName: string | null = null;
    if (wizardPayload.success) {
      if (wizardPayload.data.creationSource === 'platform_admin') {
        if (!req.user.isPlatformAdmin) {
          throw new ForbiddenError('Platform administrator authentication is required', 'CHAMA_FOUNDER_PROVISIONING_FORBIDDEN');
        }
        const founder = await findProvisioningFounder(wizardPayload.data.founderIdentifier!);
        founderId = founder.id;
        phoneNumber = founder.phone;
      } else {
        phoneNumber = req.user.phone;
      }
      wizardName = wizardPayload.data.name;
      creation = toCreateChamaWizardParams(wizardPayload.data);
    } else if (frontendPayload.success) {
      phoneNumber = req.user.phone;
      creation = toCreateChamaParams(frontendPayload.data);
    } else {
      const payload = createChamaSchema.parse(req.body) as CreateChamaParams & { phone_number: string };
      phoneNumber = payload.phone_number;
      const { phone_number: _phoneNumber, ...canonicalCreation } = payload;
      creation = canonicalCreation;
    }
    const payment = await chamaRegistrationService.initiate({ founderId, phoneNumber, creation });
    if (wizardPayload.success && wizardPayload.data.creationSource === 'platform_admin') {
      await writeAuditEvent(pool, {
        category: 'moderation',
        action: 'platform_admin_chama_provisioned',
        actorId: req.user.id,
        actorRole: 'platform_admin',
        chamaId: payment.chamaId ?? null,
        entityType: 'chama_registration_payment',
        entityId: payment.paymentId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? null,
        payload: { founderId, founderIdentifier: wizardPayload.data.founderIdentifier, paymentStatus: payment.status },
      });
    }
    const confirmed = payment.status === 'confirmed' && Boolean(payment.chamaId);
    res.status(confirmed ? 201 : 202).json({
      data: {
        ...payment,
        ...(confirmed ? {
          chama: {
            id: payment.chamaId,
            name: wizardName ?? creation.name,
            shareLink: 'joinUrl' in payment ? payment.joinUrl : null,
          },
          registrationPayment: { id: payment.paymentId, required: false },
          founderMembership: { role: 'chair', status: 'active' },
        } : {
          registrationPayment: { id: payment.paymentId, required: true },
        }),
      },
    });
	} catch (error) {
		next(error);
	}
}

async function findProvisioningFounder(identifier: string): Promise<{ id: string; phone: string }> {
  const result = await pool.query<{ id: string; phone: string }>(
    `SELECT id, phone
       FROM users
      WHERE status = 'active'
        AND (id::text = $1 OR lower(email) = lower($1) OR phone = $1)
      LIMIT 1`,
    [identifier.trim()],
  );
  const founder = result.rows[0];
  if (!founder) {
    throw new NotFoundError('No active user matches the supplied founder email, phone number, or user ID', 'CHAMA_FOUNDER_NOT_FOUND');
  }
  return founder;
}

function toCreateChamaWizardParams(payload: ReturnType<typeof createChamaWizardSchema.parse>): CreateChamaParams {
  const savingStartDate = new Date(`${payload.contributionStartDate}T00:00:00.000Z`);
  const savingEndDate = new Date(savingStartDate);
  savingEndDate.setUTCMonth(savingEndDate.getUTCMonth() + payload.durationMonths);
  const sections = payload.constitution.sections;
  const typeMap = {
    savings: 'table_banking',
    goal_based: 'goal_based',
    merry_go_round: 'merry_go_round',
    investment: 'investment',
  } as const;
  const templateMap = {
    savings: 'savings',
    goal_based: 'goal_based',
    merry_go_round: 'merry_go_round',
    investment: 'investment',
  } as const;
  return {
    name: payload.name,
    description: payload.description ?? payload.purpose,
    type: typeMap[payload.type],
    contribution_amount: payload.contributionAmount,
    contribution_frequency: payload.contributionFrequency,
    target_amount: payload.targetAmount,
    visibility: payload.recruitmentMode,
    goal_code: payload.type === 'goal_based' ? payload.goalCode : null,
    location: payload.location,
    target_members: payload.targetMembers,
    recruitment_deadline: payload.joiningWindowEndsAt,
    saving_start_date: payload.contributionStartDate,
    saving_end_date: savingEndDate.toISOString().slice(0, 10),
    constitution_template: templateMap[payload.type],
    constitution: {
      template_code: templateMap[payload.type],
      purpose_goal: sections.purposeAndGoal || payload.purpose,
      contribution_amount: payload.contributionAmount,
      contribution_frequency: payload.contributionFrequency,
      exit_withdrawal_policy: { text: sections.exitAndWithdrawal },
      payout_policy: {
        text: sections.payoutRules,
        contribution_rules: sections.contributionRules,
      },
      conduct_dispute_policy: {
        text: sections.memberConductAndDisputes,
        commitment_and_default: sections.commitmentAndDefault,
      },
      dissolution_policy: {
        text: sections.dissolution,
        voting_and_decisions: sections.votingAndDecisions,
        requires_member_vote: true,
      },
    },
  };
}

function toCreateChamaParams(payload: ReturnType<typeof createChamaFrontendSchema.parse>): CreateChamaParams {
  const savingStartDate = new Date();
  const savingEndDate = new Date(savingStartDate);
  savingEndDate.setUTCMonth(savingEndDate.getUTCMonth() + payload.duration_months);
  return {
    name: payload.name,
    description: payload.description,
    type: 'goal_based',
    contribution_amount: payload.contribution_amount,
    contribution_frequency: payload.contribution_frequency,
    target_amount: payload.target_amount,
    target_members: payload.target_members,
    goal_code: payload.goal_code,
    location: payload.location,
    visibility: payload.visibility ?? (payload.recruitment_mode === 'open' ? 'public' : 'application'),
    recruitment_deadline: payload.joining_window_ends_at,
    saving_start_date: savingStartDate.toISOString().slice(0, 10),
    saving_end_date: savingEndDate.toISOString().slice(0, 10),
    constitution: {
      template_code: 'goal_based',
      purpose_goal: payload.rules,
    },
  };
}

export async function getChamaRegistrationPayment(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    res.json({ data: await chamaRegistrationService.getStatus(req.user.id, req.params.checkoutId) });
  } catch (error) { next(error); }
}

export async function chamaRegistrationMpesaCallback(req: Request, res: Response, next: NextFunction) {
  const payload = req.body;
  const verification = (await import('../services/payment.service')).verifyMpesaCallbackRequest({
    ipAddress: req.ip,
    signature: req.header('x-mduara-signature') ?? req.header('x-callback-signature') ?? undefined,
    payload,
  });
  if (!verification.ok) {
    next(new BadRequestError('M-Pesa callback verification failed', undefined, 'MPESA_CALLBACK_UNVERIFIED'));
    return;
  }
  try {
    const result = await chamaRegistrationService.processStkCallback(payload);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted', data: result });
  } catch (error) { next(error); }
}


export async function listConstitutionTemplates(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: chamaService.listConstitutionTemplates() });
  } catch (error) { next(error); }
}

export async function getChamaConstitution(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const data = await chamaService.getConstitution(req.params.id, req.user.id);
    res.json({ data });
  } catch (error) { next(error); }
}

export async function configureChamaRules(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = constitutionSetupSchema.parse(req.body);
    const data = await chamaService.configureConstitution(req.params.id, req.user.id, input);
    res.json({ data });
  } catch (error) { next(error); }
}

export async function amendChamaRules(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const input = constitutionAmendSchema.parse(req.body);
    const data = await chamaService.amendConstitution(req.params.id, req.user.id, input);
    res.json({ data });
  } catch (error) { next(error); }
}

export async function getChama(req: Request, res: Response, next: NextFunction) {
	try {
		const chama = await chamaService.getChamaById(req.params.id);
		res.json({ data: chama });
	} catch (error) {
		next(error);
	}
}

export async function updateChama(req: Request, res: Response, next: NextFunction) {
	try {
		const payload = updateChamaSchema.parse(req.body);
		const updated = await chamaService.updateChama({ chamaId: req.params.id, updates: payload });
		res.json({ data: updated });
	} catch (error) {
		next(error);
	}
}

export async function inviteToChama(req: Request, res: Response, next: NextFunction) {
	try {
		const params = inviteSchema.parse(req.body);
		const { id: chamaId } = req.params;

		// Resolve the target user and their phone. Never fall back to the inviter's
		// phone when the invite was addressed by user id.
		const db = (await import('../db/client')).pool;
		let applicantId = params.applicant_user_id;
		let applicantPhone = params.phone;

		if (applicantId) {
			const r = await db.query(`SELECT id, phone FROM users WHERE id = $1`, [applicantId]);
			const user = r.rows[0];
			if (!user) throw new Error('No user found for provided applicant_user_id');
			applicantPhone = user.phone;
		} else if (params.phone) {
			const r = await db.query(`SELECT id, phone FROM users WHERE phone = $1`, [params.phone]);
			const user = r.rows[0];
			if (user) applicantId = user.id;
			applicantPhone = params.phone;
		}

		const { invitation, chama, inviteToken } = await chamaService.inviteApplicant({
			chamaId,
			applicantId,
			requestedRole: params.requested_role,
			message: params.message,
			phone: applicantPhone,
			expiresAt: params.expires_at,
			maxUses: params.max_uses,
			shareable: params.shareable,
		});

		const link = `${env.FRONTEND_URL ?? 'https://app.mduara.example.com'}/invite/${encodeURIComponent(inviteToken)}`;
		let responseInvitation = {
			id: invitation.id,
			chamaId: invitation.chama_id,
			applicantId: invitation.applicant_id,
			recipientPhone: invitation.recipient_phone,
			recipientEmail: invitation.recipient_email,
			requestedRole: invitation.requested_role,
			message: invitation.message,
			status: invitation.status,
			maxUses: invitation.max_uses,
			useCount: invitation.use_count,
			expiresAt: invitation.expires_at,
			createdAt: invitation.created_at,
		};
		if (applicantPhone) {
			try {
				await smsService.sendMessage(
					applicantPhone,
					`You've been invited to join ${chama.name}. Use this link to accept: ${link}`,
				);
				responseInvitation = await chamaInvitationService.markSent(chamaId, invitation.id);
			} catch (err) {
				// Best-effort; keep the invitation pending so leadership can share/retry it manually.
			}
		}

		res.status(201).json({
			data: {
				...responseInvitation,
				inviteToken,
				inviteUrl: link,
			},
		});
	} catch (error) {
		next(error);
	}
}

export async function listChamaInvitations(req: Request, res: Response, next: NextFunction) {
  try {
    const query = listInvitationsSchema.parse(req.query);
    const result = await chamaInvitationService.list({
      chamaId: req.params.id,
      page: query.page,
      perPage: query.per_page,
      status: query.status,
    });
    res.json({ data: result.invitations, meta: result.meta });
  } catch (error) {
    next(error);
  }
}

export async function cancelChamaInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const invitation = await chamaInvitationService.cancel(req.params.id, req.params.invitationId, req.user.id);
    res.json({ data: invitation });
  } catch (error) {
    next(error);
  }
}

export async function resendChamaInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    const target = await chamaInvitationService.getForResend(req.params.id, req.params.invitationId);
    const link = `${env.FRONTEND_URL ?? 'https://app.mduara.example.com'}/invite/${target.invitation.id}`;
    const chama = await chamaService.getChamaById(req.params.id);
    await smsService.sendMessage(target.phone, `You've been invited to join ${chama.name}. Use this link to accept: ${link}`);
    const invitation = await chamaInvitationService.markSent(req.params.id, req.params.invitationId);
    res.json({ data: invitation });
  } catch (error) {
    next(error);
  }
}

export async function rejectChamaInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const invitation = await chamaInvitationService.reject(req.params.id, req.params.invitationId, req.user.id);
    res.json({ data: invitation });
  } catch (error) {
    next(error);
  }
}

export async function listChamaApplications(req: Request, res: Response, next: NextFunction) {
  try {
    const query = listApplicationsSchema.parse(req.query);
    const result = await chamaApplicationService.list({
      chamaId: req.params.id,
      page: query.page,
      perPage: query.per_page,
      status: query.status,
    });
    res.json({ data: result.applications, meta: result.meta });
  } catch (error) {
    next(error);
  }
}

export async function reviewChamaApplication(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const payload = reviewApplicationSchema.parse(req.body);
    const result = await chamaApplicationService.review({
      chamaId: req.params.id,
      applicationId: req.params.applicationId,
      actorId: req.user.id,
      decision: payload.decision,
      rejectionReason: payload.rejection_reason,
    });
    if (payload.decision === 'approve') await notifyApplicationApproved(result);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function approveChamaApplicationById(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const applicationId = applicationIdSchema.parse(req.params.applicationId);
    const result = await chamaApplicationService.reviewByApplicationId({
      applicationId,
      actorId: req.user.id,
      decision: 'approve',
    });
    await notifyApplicationApproved(result);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function rejectChamaApplicationById(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const applicationId = applicationIdSchema.parse(req.params.applicationId);
    const payload = reviewApplicationSchema.parse({
      decision: 'reject',
      rejection_reason: req.body?.rejection_reason,
    });
    const result = await chamaApplicationService.reviewByApplicationId({
      applicationId,
      actorId: req.user.id,
      decision: 'reject',
      rejectionReason: payload.rejection_reason,
    });
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function listChamaMembers(req: Request, res: Response, next: NextFunction) {
	try {
		const query = listMembersSchema.parse({
			page: req.query.page ? Number(req.query.page) : undefined,
			per_page: req.query.per_page ? Number(req.query.per_page) : undefined,
			role: req.query.role as string | undefined,
			status: req.query.status as string | undefined,
		});
		const page = query.page ?? 1;
		const perPage = query.per_page ?? 25;
		const offset = (page - 1) * perPage;

		const result = await chamaService.listMembers({ chamaId: req.params.id, limit: perPage, offset, role: query.role, status: query.status });
		res.json({ data: result.members, meta: { total: result.total, page, per_page: perPage } });
	} catch (error) {
		next(error);
	}
}

export async function updateChamaMember(req: Request, res: Response, next: NextFunction) {
	try {
		const payload = updateMemberSchema.parse(req.body);
		const updated = await chamaService.updateMember({
			chamaId: req.params.id,
			userId: req.params.userId,
			updates: payload,
			actorId: req.user?.id,
			actorIp: req.ip,
			actorUserAgent: req.get('user-agent') ?? undefined,
		});
		res.json({ data: updated });
	} catch (error) {
		next(error);
	}
}

export async function listPublicChamas(req: Request, res: Response, next: NextFunction) {
  try {
    const query = publicChamaListSchema.parse(req.query);
    const result = await publicChamaService.list({
      page: query.page,
      perPage: query.per_page,
      goalCode: query.goal_code,
      status: query.status,
      visibility: query.visibility,
      type: query.type,
      location: query.location,
      minContribution: query.min_contribution,
      maxContribution: query.max_contribution,
      minDurationMonths: query.min_duration_months,
      maxDurationMonths: query.max_duration_months,
      hasCapacity: query.has_capacity,
      minAvailableSpots: query.min_available_spots,
    });
    res.json({ data: result.chamas, meta: result.meta });
  } catch (error) {
    next(error);
  }
}

export async function getPublicChamaDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const detail = await publicChamaService.getPublicDetail(req.params.id);
    res.json({ data: detail });
  } catch (error) {
    next(error);
  }
}

export async function getPublicChamaDetailByJoinCode(req: Request, res: Response, next: NextFunction) {
  try {
    const detail = await publicChamaService.getPublicDetailByJoinCode(req.params.joinCode);
    res.json({ data: detail });
  } catch (error) { next(error); }
}

export async function applyToChama(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) throw new UnauthorizedError();
    const payload = publicChamaApplySchema.parse(req.body);
    if (!payload.accept_constitution) {
      throw new BadRequestError('Constitution must be accepted before joining', undefined, 'CONSTITUTION_NOT_ACCEPTED');
    }
    const result = await publicChamaService.apply({
      userId: req.user.id,
      chamaId: req.params.id,
      constitutionRuleId: payload.constitution_rule_id,
      message: payload.message,
      invitationId: payload.invitation_id,
      invitationToken: payload.invitation_token,
      acceptanceIp: req.ip,
      acceptanceUserAgent: req.get('user-agent') ?? null,
    });
    res.status(result.outcome === 'application_pending' ? 202 : 201).json({ data: result });
  } catch (error) {
    next(error);
  }
}

export default {
  createChama,
  getChamaRegistrationPayment,
  chamaRegistrationMpesaCallback,
  listConstitutionTemplates,
  getChamaConstitution,
  configureChamaRules,
  amendChamaRules,
  getChama,
  updateChama,
  inviteToChama,
  listChamaInvitations,
  cancelChamaInvitation,
  resendChamaInvitation,
  rejectChamaInvitation,
  listChamaApplications,
  reviewChamaApplication,
  approveChamaApplicationById,
  rejectChamaApplicationById,
  listChamaMembers,
  updateChamaMember,
  listPublicChamas,
  getPublicChamaDetail,
  getPublicChamaDetailByJoinCode,
  applyToChama,
};
