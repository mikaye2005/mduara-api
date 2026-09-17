/** Global identity roles. Chama offices are deliberately scoped separately. */
export const ROLES = ['SUPER_ADMIN', 'MEMBER'] as const;
export type Role = (typeof ROLES)[number];

/** Chama-scoped membership capabilities. Every official also inherits MEMBER. */
export const CHAMA_ROLES = [
  'MEMBER',
  'CHAIRPERSON',
  'TREASURER',
  'SECRETARY',
] as const;
export type ChamaRole = (typeof CHAMA_ROLES)[number];
export type ChamaOffice = Exclude<ChamaRole, 'MEMBER'>;

export interface AuthenticatedUser {
  userId: string;
  roles: readonly Role[];
}

export interface ActiveChamaMembership {
  chamaId: string;
  userId: string;
  role: ChamaRole;
  officialRole: ChamaOffice | null;
}

/**
 * Minimal Express-compatible contracts. Keeping these structural avoids
 * coupling the authorization core to a web framework before one is chosen.
 */
export interface ApiRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | undefined>;
  originalUrl?: string;
  url?: string;
  auth?: AuthenticatedUser;
  chamaMembership?: ActiveChamaMembership;
}

export interface ApiResponse {
  status(statusCode: number): {
    json(body: unknown): unknown;
  };
}

export type NextFunction = (error?: unknown) => void;
export type Middleware = (
  request: ApiRequest,
  response: ApiResponse,
  next: NextFunction,
) => void | Promise<void>;
