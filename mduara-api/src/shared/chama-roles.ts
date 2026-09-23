/**
 * Canonical PostgreSQL Chama membership-role semantics.
 *
 * Every chama_members row represents a Member. The `member` value means the
 * membership holds no official office. The other values represent the one
 * official office held by that membership and always inherit Member
 * capabilities. Platform administration is deliberately not represented here;
 * it lives only on users.is_platform_admin.
 */
export const DATABASE_CHAMA_ROLES = [
  'member',
  'treasurer',
  'secretary',
  'chairperson',
] as const;

export type DatabaseChamaRole = (typeof DATABASE_CHAMA_ROLES)[number];
export type DatabaseChamaOffice = Exclude<DatabaseChamaRole, 'member'>;

const DATABASE_CHAMA_ROLE_SET = new Set<string>(DATABASE_CHAMA_ROLES);

export function isDatabaseChamaRole(value: unknown): value is DatabaseChamaRole {
  return typeof value === 'string' && DATABASE_CHAMA_ROLE_SET.has(value);
}

export function isDatabaseChamaOffice(role: DatabaseChamaRole): role is DatabaseChamaOffice {
  return role !== 'member';
}

/**
 * Returns whether a stored membership role satisfies one required capability.
 * Every official is also a Member, but one office never implies another office.
 */
export function databaseChamaRoleSatisfies(
  actualRole: DatabaseChamaRole,
  requiredRole: DatabaseChamaRole,
): boolean {
  return requiredRole === 'member' || actualRole === requiredRole;
}

export function databaseChamaRoleMatchesAny(
  actualRole: DatabaseChamaRole,
  allowedRoles: readonly DatabaseChamaRole[],
): boolean {
  return allowedRoles.some((requiredRole) => databaseChamaRoleSatisfies(actualRole, requiredRole));
}
