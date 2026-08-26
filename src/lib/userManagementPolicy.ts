import { hasPermission, normalizeGovernanceRole, type Permission, type PermissionSubject } from '@/lib/permissions';
import type { RoleKey } from '@/types/iam';

export type UserOperation = 'create' | 'update' | 'role.change' | 'disable' | 'delete' | 'enable' | 'lock' | 'unlock' | 'password.reset';
export type ManagementActor = PermissionSubject & { username: string };
export type ManagementTarget = { username: string; role: string };

export class UserManagementError extends Error {
  constructor(public readonly code: string, public readonly status = 403) { super(code); }
}

export const USER_OPERATION_PERMISSIONS: Record<UserOperation, Permission> = {
  create: 'users.create', update: 'users.update', 'role.change': 'users.role.change',
  disable: 'users.disable', delete: 'users.delete', enable: 'users.disable', lock: 'users.disable',
  unlock: 'users.unlock', 'password.reset': 'users.reset-password',
};

export function assignableRoles(actor: ManagementActor): RoleKey[] {
  if (!hasPermission(actor, 'users.create') && !hasPermission(actor, 'users.role.change')) return [];
  switch (normalizeGovernanceRole(actor.role)) {
    case 'super_admin': return ['root', 'ops_admin', 'operator', 'auditor', 'viewer'];
    case 'ops_admin': return ['operator', 'auditor', 'viewer'];
    default: return [];
  }
}

/** Permission + target rules. Must run again under the repository lifecycle lock. */
export function checkUserManagementPolicy(actor: ManagementActor, target: ManagementTarget | null, operation: UserOperation, nextRole?: unknown): void {
  if (!hasPermission(actor, USER_OPERATION_PERMISSIONS[operation])) throw new UserManagementError('PERMISSION_DENIED');
  if (target) {
    if (actor.username === target.username) {
      if (operation === 'disable' || operation === 'lock') throw new UserManagementError('SELF_DISABLE_FORBIDDEN');
      if (operation === 'delete') throw new UserManagementError('SELF_DELETE_FORBIDDEN');
      if (operation === 'role.change') throw new UserManagementError('SELF_ROLE_CHANGE_FORBIDDEN');
    }
    const actorRole = normalizeGovernanceRole(actor.role);
    const targetRole = normalizeGovernanceRole(target.role);
    if (!targetRole || (actorRole !== 'super_admin' && (targetRole === 'super_admin' || targetRole === 'ops_admin'))) {
      throw new UserManagementError('TARGET_ROLE_PROTECTED');
    }
  }
  if (operation === 'create' || operation === 'role.change') {
    const normalized = normalizeGovernanceRole(nextRole);
    if (!normalized || !assignableRoles(actor).some((role) => normalizeGovernanceRole(role) === normalized)) {
      throw new UserManagementError('ROLE_ASSIGNMENT_FORBIDDEN');
    }
  }
}

export function userManagementActions(actor: ManagementActor, target: ManagementTarget): UserOperation[] {
  return (Object.keys(USER_OPERATION_PERMISSIONS) as UserOperation[]).filter((operation) => {
    if (operation === 'create' || operation === 'delete') return false;
    try { checkUserManagementPolicy(actor, target, operation, operation === 'role.change' ? 'viewer' : undefined); return true; }
    catch { return false; }
  });
}
