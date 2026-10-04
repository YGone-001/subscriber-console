import type { AuthUser, CanonicalRole } from '../types/auth';

export function normalizeRole(role: string): CanonicalRole | null {
  if (role === 'admin' || role === 'root' || role === 'super_admin') return 'admin';
  if (role === 'operator' || role === 'ops_admin') return 'operator';
  if (role === 'viewer' || role === 'auditor') return 'viewer';
  return null;
}

export function hasNavigationPermission(role: CanonicalRole | undefined, permission?: 'users.read'): boolean {
  if (!permission) return true;
  return role === 'admin';
}

export function hasPermission(user: AuthUser | null | undefined, permission?: string | null): boolean {
  if (!permission) return true;
  if (!user) return false;
  if (Array.isArray(user.permissions)) {
    return user.permissions.includes(permission);
  }
  return false;
}
