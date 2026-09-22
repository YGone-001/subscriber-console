import type { Capability, CapabilityDecision, RoleKey } from '@/types/iam';
import type { GovernanceRole } from '@/types/governance';

export type { Capability, CapabilityDecision } from '@/types/iam';

export type CapabilityGuardOptions = {
  allowApproval?: boolean;
  allowExport?: boolean;
};

const CANONICAL_CAPABILITIES = {
  admin: {
    subscriber_write: 'allow',
    policy_approve: 'allow',
    balance_adjust: 'allow',
    profile_rollback: 'allow',
    rating_publish: 'allow',
    approval_review: 'allow',
    approval_execute: 'allow',
    audit_view: 'allow',
    audit_export: 'export',
    system_heal: 'allow',
    user_admin: 'allow',
  },
  operator: {
    subscriber_write: 'allow',
    policy_approve: 'allow',
    balance_adjust: 'allow',
    profile_rollback: 'allow',
    rating_publish: 'allow',
    approval_review: 'deny',
    approval_execute: 'deny',
    audit_view: 'allow',
    audit_export: 'deny',
    system_heal: 'allow',
    user_admin: 'deny',
  },
  viewer: {
    subscriber_write: 'deny',
    policy_approve: 'deny',
    balance_adjust: 'deny',
    profile_rollback: 'deny',
    rating_publish: 'deny',
    approval_review: 'deny',
    approval_execute: 'deny',
    audit_view: 'allow',
    audit_export: 'deny',
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
  if (decision === 'allow') return true;
  if (decision === 'approval') return options.allowApproval === true;
  if (decision === 'export') return options.allowExport === true;
  return false;
}

/** Built-in catalog; keep the legacy capability matrix intact during rollout. */
export const PERMISSION_CATALOG = [
  'users.read', 'users.create', 'users.update', 'users.disable', 'users.delete',
  'users.role.change', 'users.reset-password', 'users.unlock',
  'approvals.read', 'approvals.create', 'approvals.approve', 'approvals.reject',
  'approvals.cancel', 'approvals.execute',
  'audit.read', 'audit.export', 'audit.source-ip.read-full',
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
    'audit.read',
    'ocs.read', 'ocs.balance.adjust', 'ocs.tariff.write', 'ocs.plan.assign', 'ocs.rating.write',
    'approvals.read', 'approvals.create', 'approvals.cancel',
  ],
  viewer: [
    'subscribers.read', 'profiles.read', 'ocs.read', 'core.read',
    'approvals.read', 'audit.read',
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

/** Permission grants do not bypass resource checks, approval, or Maker-Checker. */
export function permissionsFor(user: PermissionSubject | null | undefined): Permission[] {
  return PERMISSION_CATALOG.filter((permission) => hasPermission(user, permission));
}
