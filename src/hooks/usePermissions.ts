'use client';
import { useAuth } from '@/hooks/useAuth';
import { hasPermission, normalizeGovernanceRole, type Permission } from '@/lib/permissions';

export function usePermissions() {
  const auth = useAuth();
  return { ...auth, role: auth.user?.role, normalizedRole: normalizeGovernanceRole(auth.user?.role), can: (permission: Permission) => hasPermission(auth.user, permission) };
}
