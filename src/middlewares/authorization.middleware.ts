import type { Pool } from 'pg';
import { pool } from '../db/client';
import { isAuthenticated, sendUnauthorized } from './auth.middleware';
import { assertSubscriptionWriteAccess } from '../services/subscription.service';
import type {
  ActiveChamaMembership,
  ApiRequest,
  ApiResponse,
  ChamaOffice,
  ChamaRole,
  Middleware,
  Role,
} from '../types/auth';

const ADMIN_ROLES: readonly Role[] = ['SUPER_ADMIN'];
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CHAMA_ROLES: readonly ChamaRole[] = [
  'MEMBER',
  'CHAIRPERSON',
  'TREASURER',
  'SECRETARY',
];

const DATABASE_TO_API_ROLE: Readonly<Record<string, ChamaRole>> = {
  chairperson: 'CHAIRPERSON',
  treasurer: 'TREASURER',
  secretary: 'SECRETARY',
  member: 'MEMBER',
};

export interface ChamaMembershipRepository {
  findActiveMembership(userId: string, chamaId: string): Promise<ActiveChamaMembership | null>;
}

export interface ChamaPolicy {
  /** The route parameter carrying the Chama id. Defaults to `chamaId`. */
  chamaIdParam?: string;
  /** Only these active Chama capabilities may proceed. Omit for any active member. */
  allowedRoles?: readonly ChamaRole[];
  /** Platform admins may bypass Chama membership; enabled by default. */
  allowSuperAdmin?: boolean;
  /** Unsafe HTTP methods are blocked after a paid-subscription grace period by default. */
  enforceSubscriptionWrites?: boolean;
  repository?: ChamaMembershipRepository;
}

/**
 * Every official is still a Member. Office capabilities do not imply one
 * another: Secretary does not satisfy Treasurer, etc.
 */
export function chamaRoleSatisfies(actualRole: ChamaRole, requiredRole: ChamaRole): boolean {
  return requiredRole === 'MEMBER' || actualRole === requiredRole;
}

export function chamaRoleMatchesAny(
  actualRole: ChamaRole,
  allowedRoles: readonly ChamaRole[],
): boolean {
  return allowedRoles.some((requiredRole) => chamaRoleSatisfies(actualRole, requiredRole));
}

/**
 * Requires a verified identity to have one of the supplied global roles.
 * This is intentionally platform/global only; Chama offices are never global
 * identity roles and must use requireChamaMembership/requireChamaRoles.
 */
export function requireRoles(allowedRoles: readonly Role[]): Middleware {
  const allowed = new Set(allowedRoles);

  return (request, response, next) => {
    if (!isAuthenticated(request)) {
      sendUnauthorized(response, 'Authentication is required');
      return;
    }

    if (!request.auth.roles.some((role) => allowed.has(role))) {
      sendForbidden(response, 'Your role is not permitted to perform this action');
      return;
    }

    next();
  };
}

/** Restricts every /api/v1/admin route to a verified SUPER_ADMIN identity. */
export function protectAdministrativeRoutes(prefix = '/api/v1/admin'): Middleware {
  const normalizedPrefix = normalizePath(prefix);
  const requireAdmin = requireRoles(ADMIN_ROLES);

  return (request, response, next) => {
    const path = normalizePath(request.originalUrl ?? request.url ?? '');
    if (path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`)) {
      return requireAdmin(request, response, next);
    }
    next();
  };
}

/**
 * Requires active membership of the Chama identified by the route parameter.
 * PostgreSQL is authoritative: stale token claims cannot preserve access after
 * suspension, exit, default or office reassignment.
 */
export function requireChamaMembership(policy: ChamaPolicy = {}): Middleware {
  const chamaIdParam = policy.chamaIdParam ?? 'chamaId';
  const repository = policy.repository ?? postgresChamaMembershipRepository;
  const allowSuperAdmin = policy.allowSuperAdmin ?? true;
  const enforceSubscriptionWrites = policy.enforceSubscriptionWrites ?? true;
  const allowedRoles = policy.allowedRoles ? [...policy.allowedRoles] : undefined;

  return async (request, response, next) => {
    if (!isAuthenticated(request)) {
      sendUnauthorized(response, 'Authentication is required');
      return;
    }

    const chamaId = request.params?.[chamaIdParam]?.trim();
    if (!chamaId) {
      sendForbidden(response, 'A Chama scope is required for this action', 'CHAMA_SCOPE_REQUIRED');
      return;
    }

    if (allowSuperAdmin && request.auth.roles.includes('SUPER_ADMIN')) {
      next();
      return;
    }

    try {
      const membership = await repository.findActiveMembership(request.auth.userId, chamaId);
      if (!membership) {
        sendForbidden(response, 'You are not an active member of this Chama', 'CHAMA_MEMBERSHIP_INACTIVE');
        return;
      }

      if (allowedRoles && !chamaRoleMatchesAny(membership.role, allowedRoles)) {
        sendForbidden(response, 'Your Chama role is not permitted to perform this action', 'CHAMA_ROLE_FORBIDDEN');
        return;
      }

      if (enforceSubscriptionWrites && !SAFE_HTTP_METHODS.has(String(request.method ?? 'GET').toUpperCase())) {
        await assertSubscriptionWriteAccess(pool, chamaId);
      }

      request.chamaMembership = membership;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Convenience helper for Chama-scoped office/member capabilities. */
export function requireChamaRoles(
  allowedRoles: readonly ChamaRole[],
  policy: Omit<ChamaPolicy, 'allowedRoles'> = {},
): Middleware {
  if (allowedRoles.some((role) => !CHAMA_ROLES.includes(role))) {
    throw new Error('Only Chama-scoped roles may be used in a Chama role policy');
  }

  return requireChamaMembership({ ...policy, allowedRoles });
}

export function sendForbidden(response: ApiResponse, message = 'Forbidden', code = 'FORBIDDEN'): void {
  response.status(403).json({ error: { code, message } });
}

export function createPostgresChamaMembershipRepository(
  db: Pick<Pool, 'query'> = pool,
): ChamaMembershipRepository {
  return {
    async findActiveMembership(userId, chamaId) {
      const result = await db.query<{ chama_id: string; user_id: string; role: string }>(
        `SELECT chama_id, user_id, role::text AS role
         FROM chama_members
         WHERE chama_id = $1
           AND user_id = $2
           AND membership_status = 'active'`,
        [chamaId, userId],
      );
      const row = result.rows[0];
      const role = row ? DATABASE_TO_API_ROLE[row.role] : undefined;

      if (!row || !role) return null;

      return {
        chamaId: row.chama_id,
        userId: row.user_id,
        role,
        officialRole: role === 'MEMBER' ? null : (role as ChamaOffice),
      };
    },
  };
}

const postgresChamaMembershipRepository = createPostgresChamaMembershipRepository();

function normalizePath(value: string): string {
  const path = value.split('?', 1)[0].replace(/\/+$/, '');
  return path || '/';
}
