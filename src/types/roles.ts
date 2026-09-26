export type Role = 'OBSERVER' | 'OPERATOR' | 'AUDITOR' | 'ADMIN' | 'SUPER_ADMIN';

export type Permission =
  | 'read:prices'
  | 'read:market'
  | 'write:oracle'
  | 'read:config'
  | 'write:config'
  | 'read:audit'
  | 'read:keys'
  | 'write:keys'
  | '*';

/**
 * Fine-grained permission matrix for the Relayer Admin API (Issue #1063).
 *
 * - ADMIN / SUPER_ADMIN: unrestricted access, including key management.
 * - OPERATOR: may operate the oracle and read configuration, but can never
 *   touch key material.
 * - AUDITOR: read-only access, including audit trails, with no write access.
 * - OBSERVER: minimal read-only access to public market data.
 */
export const ROLE_MATRIX: Record<Role, Permission[]> = {
  OBSERVER: ['read:prices', 'read:market'],
  OPERATOR: ['read:prices', 'read:market', 'write:oracle', 'read:config'],
  AUDITOR: ['read:prices', 'read:market', 'read:config', 'read:audit', 'read:keys'],
  ADMIN: ['*'],
  SUPER_ADMIN: ['*'],
};

/** Permissions that only an ADMIN (or SUPER_ADMIN) session may ever hold. */
export const ADMIN_ONLY_PERMISSIONS: Permission[] = ['write:keys', 'write:config'];

export const ADMIN_ROLES: Role[] = ['ADMIN', 'SUPER_ADMIN'];

export function isAdminRole(role: string | undefined | null): boolean {
  return !!role && ADMIN_ROLES.includes(role as Role);
}

export function permissionsForRole(role: string | undefined | null): Permission[] {
  if (!role) {
    return [];
  }

  return ROLE_MATRIX[role as Role] ?? [];
}

export function roleHasPermission(
  role: string | undefined | null,
  permission: Permission,
): boolean {
  const permissions = permissionsForRole(role);

  return permissions.includes('*') || permissions.includes(permission);
}
