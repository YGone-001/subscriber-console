import type { UserRole } from '@/lib/authz';

export type Capability =
  | 'subscriber_write'
  | 'policy_approve'
  | 'balance_adjust'
  | 'profile_rollback'
  | 'rating_publish'
  | 'audit_export'
  | 'system_heal'
  | 'user_admin';

export type CapabilityDecision = 'allow' | 'approval' | 'export' | 'deny';

export type CapabilityGuardOptions = {
  allowApproval?: boolean;
  allowExport?: boolean;
};

export const ROLE_CAPABILITIES: Record<UserRole, Record<Capability, CapabilityDecision>> = {
  root: {
    subscriber_write: 'allow',
    policy_approve: 'allow',
    balance_adjust: 'allow',
    profile_rollback: 'allow',
    rating_publish: 'allow',
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
    audit_export: 'export',
    system_heal: 'approval',
    user_admin: 'deny',
  },
  viewer: {
    subscriber_write: 'deny',
    policy_approve: 'deny',
    balance_adjust: 'deny',
    profile_rollback: 'deny',
    rating_publish: 'deny',
    audit_export: 'export',
    system_heal: 'deny',
    user_admin: 'deny',
  },
};

export function capabilityDecision(role: UserRole, capability: Capability): CapabilityDecision {
  return ROLE_CAPABILITIES[role]?.[capability] || 'deny';
}

export function capabilityAllowed(decision: CapabilityDecision, options: CapabilityGuardOptions = {}) {
  if (decision === 'allow') return true;
  if (decision === 'approval') return options.allowApproval === true;
  if (decision === 'export') return options.allowExport === true;
  return false;
}
