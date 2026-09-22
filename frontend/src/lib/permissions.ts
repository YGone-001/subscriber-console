import type { Capability, CapabilityDecision, RoleKey } from '@/types/iam';
import type { GovernanceRole } from '@/types/governance';

export type { Capability, CapabilityDecision } from '@/types/iam';

export type CapabilityGuardOptions = Record<string, never>;

const CANONICAL_CAPABILITIES = {
  admin: {
    subscriber_write: 'allow',
    policy_approve: 'allow',
    balance_adjust: 'allow',
    profile_rollback: 'allow',
    rating_publish: 'allow',
    system_heal: 'allow',
    user_admin: 'allow',
  },
  operator: {
    subscriber_write: 'allow',
    policy_approve: 'allow',
    balance_adjust: 'allow',
    profile_rollback: 'allow',
    rating_publish: 'allow',
    system_heal: 'allow',
    user_admin: 'deny',
  },
  viewer: {
    subscriber_write: 'deny',
    policy_approve: 'deny',
    balance_adjust: 'deny',
    profile_rollback: 'deny',
    rating_publish: 'deny',
    system_heal: 'deny',
    user_admin: 'deny',
  },
} as const;

export const ROLE_CAPABILITIES: Record<RoleKey, Record<Capability, CapabilityDecision>> = {
  admin: CANONICAL_CAPABILITIES.admin,
  operator: CANONICAL_CAPABILITIES.operator,
  viewer: CANONICAL_CAPABILITIES.viewer,
  root: CANONICAL_CAPABILITIES.admin,
  super_admin: CANONICAL_CAPABILITIES.admin,
  ops_admin: CANONICAL_CAPABILITIES.operator,
  auditor: CANONICAL_CAPABILITIES.viewer,
};

export function capabilityDecision(role: RoleKey | string | unknown, capability: Capability): CapabilityDecision {
  const canonical = normalizeGovernanceRole(role);
  if (!canonical) return 'deny';
  return CANONICAL_CAPABILITIES[canonical]?.[capability] || 'deny';
}

export function capabilityAllowed(decision: CapabilityDecision, options: CapabilityGuardOptions = {}) {
  void options;
  if (decision === 'allow') return true;
  return false;
}

/** Built-in catalog for active direct-operation and read surfaces. */
export const PERMISSION_CATALOG = [
  'users.read', 'users.create', 'users.update', 'users.disable', 'users.delete',
  'users.role.change', 'users.reset-password', 'users.unlock',
  'subscribers.read', 'subscribers.write', 'subscribers.delete',
  'ocs.read', 'ocs.balance.adjust', 'ocs.balance.reset', 'ocs.tariff.write', 'ocs.plan.assign', 'ocs.rating.write', 'ocs.runtime.execute',
  'profiles.read', 'profiles.write',
  'core.read', 'core.operate', 'core.configure',
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number];

export const ROLE_PERMISSIONS: Readonly<Record<GovernanceRole, readonly Permission[]>> = {
  admin: [...PERMISSION_CATALOG],
  operator: [
    'subscribers.read', 'subscribers.write', 'subscribers.delete',
    'profiles.read', 'profiles.write',
    'core.read', 'core.operate', 'core.configure',
    'ocs.read', 'ocs.balance.adjust', 'ocs.tariff.write', 'ocs.plan.assign', 'ocs.rating.write',
  ],
  viewer: [
    'subscribers.read', 'profiles.read', 'ocs.read', 'core.read',
  ],
};

export function normalizeGovernanceRole(role: unknown): GovernanceRole | null {
  switch (role) {
    case 'admin':
    case 'root':
    case 'super_admin':
      return 'admin';
    case 'operator':
    case 'ops_admin':
      return 'operator';
    case 'viewer':
    case 'auditor':
      return 'viewer';
    default:
      return null;
  }
}

export function isSuperAdmin(role: unknown): boolean {
  return normalizeGovernanceRole(role) === 'admin';
}

export function isAdmin(role: unknown): boolean {
  return normalizeGovernanceRole(role) === 'admin';
}

export type PermissionSubject = { role?: string; status?: string; locked?: boolean };

export function hasPermission(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user || user.locked || (user.status !== undefined && user.status !== 'active')) return false;
  const role = normalizeGovernanceRole(user.role);
  return role !== null && ROLE_PERMISSIONS[role].includes(permission);
}

/** Permission grants do not bypass resource, state, or domain validation. */
export function permissionsFor(user: PermissionSubject | null | undefined): Permission[] {
  return PERMISSION_CATALOG.filter((permission) => hasPermission(user, permission));
}
