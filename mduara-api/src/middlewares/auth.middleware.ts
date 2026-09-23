import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/client';
import { tokenService } from '../services/token.service';
import { UnauthorizedError } from '../utils/errors';
import type { AuthenticatedUser } from '../types';
import type { ApiRequest, ApiResponse, AuthenticatedUser as AuthorizationUser, Role } from '../types/auth';

interface UserRow {
  id: string;
  phone: string;
  email: string;
  status: string;
  is_platform_admin: boolean;
  session_version: number;
}

export function isAuthenticated(request: ApiRequest): request is ApiRequest & { auth: AuthorizationUser } {
  return Boolean(request.auth);
}


/** Global platform roles derive only from the identity-level admin flag. Chama offices never participate. */
export function identityRolesFromPlatformFlag(isPlatformAdmin: boolean): readonly Role[] {
  return isPlatformAdmin ? ['SUPER_ADMIN'] : ['MEMBER'];
}

export function sendUnauthorized(response: ApiResponse, message = 'Unauthorized'): void {
  response.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
}

/** Requires a valid access token whose session version still matches PostgreSQL. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) throw new UnauthorizedError('Missing bearer token');

    const payload = tokenService.verifyAccessToken(token);
    const result = await pool.query<UserRow>(
      `SELECT id, phone, email, status, is_platform_admin, session_version
       FROM users
       WHERE id = $1`,
      [payload.sub],
    );
    const user = result.rows[0];

    if (
      !user
      || user.status !== 'active'
      || user.session_version !== payload.sessionVersion
      || user.phone !== payload.phone
    ) {
      throw new UnauthorizedError('Session is no longer valid');
    }

    req.user = {
      id: user.id,
      phone: user.phone,
      email: user.email,
      status: user.status,
      isPlatformAdmin: user.is_platform_admin,
      sessionVersion: user.session_version,
    } satisfies AuthenticatedUser;

    // Chama offices are intentionally not global roles. Chama-scoped middleware
    // remains responsible for resolving Secretary/Treasurer/Chair permissions.
    const roles = identityRolesFromPlatformFlag(user.is_platform_admin);
    req.auth = { userId: user.id, roles };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Allows public endpoints to consume authenticated context when a bearer token
 * is supplied, while remaining anonymous when no Authorization header exists.
 * A malformed/invalid supplied token still fails closed through authenticate().
 */
export async function optionalAuthenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.headers.authorization) {
    next();
    return;
  }
  await authenticate(req, res, next);
}
