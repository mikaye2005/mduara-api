import type { Pool } from 'pg';
import { pool } from '../db/client';
import { UnauthorizedError } from '../utils/errors';
import type { ChamaMembershipRole, SessionContext, SessionMembershipContext } from '../types';

interface UserRow {
  id: string;
  phone: string;
  email: string;
  full_name: string;
  national_id: string | null;
  avatar_url: string | null;
  date_of_birth: string | null;
  status: string;
  is_email_verified: boolean;
  is_platform_admin: boolean;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  membership_id: string;
  chama_id: string;
  chama_name: string;
  logo_url: string | null;
  membership_status: string;
  role: string;
  joined_at: string | null;
}

const DATABASE_TO_SESSION_ROLE: Readonly<Record<string, ChamaMembershipRole>> = {
  chairperson: 'chair',
  treasurer: 'treasurer',
  secretary: 'secretary',
  member: 'member',
};

/** Builds the authoritative post-login/session-restoration context from PostgreSQL. */
export class SessionService {
  constructor(private readonly databasePool: Pool = pool) {}

  async getContext(userId: string): Promise<SessionContext> {
    const [userResult, membershipResult] = await Promise.all([
      this.databasePool.query<UserRow>(
        `SELECT id, phone, email, full_name, national_id, avatar_url, date_of_birth, status,
                is_email_verified, is_platform_admin, created_at, updated_at
         FROM users
         WHERE id = $1`,
        [userId],
      ),
      this.databasePool.query<MembershipRow>(
        `SELECT cm.id AS membership_id,
                cm.chama_id,
                c.name AS chama_name,
                c.logo_url,
                cm.membership_status::text AS membership_status,
                cm.role::text AS role,
                cm.joined_at
         FROM chama_members cm
         JOIN chamas c ON c.id = cm.chama_id
         WHERE cm.user_id = $1
         ORDER BY
           CASE WHEN cm.membership_status = 'active' THEN 0 ELSE 1 END,
           cm.joined_at DESC NULLS LAST,
           cm.id ASC`,
        [userId],
      ),
    ]);

    const user = userResult.rows[0];
    if (!user || user.status !== 'active') throw new UnauthorizedError('Account is not active');

    const memberships: SessionMembershipContext[] = membershipResult.rows.flatMap((row) => {
      const role = DATABASE_TO_SESSION_ROLE[row.role];
      if (!role) return [];
      return [{
        membershipId: row.membership_id,
        chamaId: row.chama_id,
        name: row.chama_name,
        logoUrl: row.logo_url,
        membershipStatus: row.membership_status,
        role,
        officialRole: row.membership_status === 'active' && role !== 'member' ? role : null,
        joinedAt: row.joined_at,
      }];
    });

    const defaultMembership = memberships.find((membership) => membership.membershipStatus === 'active') ?? null;

    return {
      user: {
        id: user.id,
        fullName: user.full_name,
        phone: user.phone,
        email: user.email,
        nationalId: user.national_id,
        avatarUrl: user.avatar_url,
        dateOfBirth: user.date_of_birth,
        status: user.status,
        isEmailVerified: user.is_email_verified,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
      isPlatformAdmin: user.is_platform_admin,
      memberships,
      defaultContext: defaultMembership
        ? {
          chamaId: defaultMembership.chamaId,
          membershipId: defaultMembership.membershipId,
          workspace: 'member',
        }
        : null,
    };
  }
}

export const sessionService = new SessionService();
