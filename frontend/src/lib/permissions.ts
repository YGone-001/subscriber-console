import type { Capability, CapabilityDecision, RoleKey } from '@/types/iam';
import type { GovernanceRole } from '@/types/governance';

export type { Capability, CapabilityDecision } from '@/types/iam';

export type CapabilityGuardOptions = {
  allowApproval?: boolean;
  allowExport?: boolean;
};

const LEGACY_CAPABILITIES = {
  root: {
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
    policy_approve: 'approval',
    balance_adjust: 'approval',
    profile_rollback: 'approval',
    rating_publish: 'approval',
    approval_review: 'deny',
    approval_execute: 'deny',
    audit_view: 'allow',
    audit_export: 'deny',
    system_heal: 'approval',
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
  ...LEGACY_CAPABILITIES,
  super_admin: LEGACY_CAPABILITIES.root,
  ops_admin: { ...LEGACY_CAPABILITIES.root, user_admin: 'deny' },
  auditor: { ...LEGACY_CAPABILITIES.viewer, audit_export: 'export' },
};

export function capabilityDecision(role: RoleKey, capability: Capability): CapabilityDecision {
  return ROLE_CAPABILITIES[role]?.[capability] || 'deny';
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

const READ_PERMISSIONS = PERMISSION_CATALOG.filter((permission) => permission.endsWith('.read'));

export const ROLE_PERMISSIONS: Readonly<Record<GovernanceRole, readonly Permission[]>> = {
  super_admin: [...PERMISSION_CATALOG],
  ops_admin: [
    'users.create', 'users.update', 'users.disable', 'users.delete', 'users.role.change', 'users.reset-password', 'users.unlock',
    ...READ_PERMISSIONS, 'approvals.create', 'approvals.approve', 'approvals.reject',
    'approvals.cancel', 'approvals.execute', 'audit.export',
    'subscribers.write', 'subscribers.delete', 'profiles.write', 'core.operate', 'core.configure',
    'ocs.balance.adjust', 'ocs.tariff.write', 'ocs.plan.assign', 'ocs.rating.write',
  ],
  operator: [
    'subscribers.read', 'subscribers.write', 'subscribers.delete',
    'profiles.read', 'core.read', 'core.operate', 'audit.read',
    'ocs.read', 'ocs.balance.adjust', 'ocs.tariff.write', 'ocs.plan.assign', 'ocs.rating.write',
    'approvals.read', 'approvals.create', 'approvals.cancel',
  ],
  auditor: ['users.read', 'approvals.read', 'audit.read', 'audit.export', 'audit.source-ip.read-full'],
  viewer: ['subscribers.read', 'profiles.read', 'ocs.read', 'core.read', 'approvals.read', 'audit.read'],
};

export function normalizeGovernanceRole(role: unknown): GovernanceRole | null {
  // Existing JWTs and app_users keep root. This is an authorization alias only.
  if (role === 'root') return 'super_admin';
  switch (role) {
    case 'super_admin': case 'ops_admin': case 'operator': case 'auditor': case 'viewer':
      return role;
    default:
      return null;
  }
}

export function isSuperAdmin(role: unknown): boolean {
  return normalizeGovernanceRole(role) === 'super_admin';
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
