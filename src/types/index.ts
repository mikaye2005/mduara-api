import type { ActiveChamaMembership, AuthenticatedUser as AuthorizationUser } from './auth';

export type ChamaMembershipRole = 'member' | 'chair' | 'secretary' | 'treasurer';

export interface SessionMembershipClaim {
  membershipId: string;
  chamaId: string;
  role: ChamaMembershipRole;
}

export interface AuthenticatedUser {
  id: string;
  phone: string;
  email: string;
  status: string;
  isPlatformAdmin: boolean;
  sessionVersion: number;
}

export interface AccessTokenPayload {
  sub: string;
  phone: string;
  type: 'access';
  isPlatformAdmin: boolean;
  sessionVersion: number;
  memberships: readonly SessionMembershipClaim[];
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface SessionMembershipContext {
  membershipId: string;
  chamaId: string;
  name: string;
  logoUrl: string | null;
  membershipStatus: string;
  role: ChamaMembershipRole;
  officialRole: Exclude<ChamaMembershipRole, 'member'> | null;
  joinedAt: string | null;
}

export interface SessionContext {
  user: {
    id: string;
    fullName: string;
    phone: string;
    email: string;
    nationalId: string | null;
    avatarUrl: string | null;
    dateOfBirth: string | null;
    status: string;
    mustChangePassword: boolean;
    isEmailVerified: boolean;
    createdAt: string;
    updatedAt: string;
  };
  isPlatformAdmin: boolean;
  memberships: SessionMembershipContext[];
  defaultContext: {
    chamaId: string;
    membershipId: string;
    workspace: 'member';
  } | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      auth?: AuthorizationUser;
      chamaMembership?: ActiveChamaMembership;
    }
  }
}

export {};
