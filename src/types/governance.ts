/** Shared wire types. Existing collections continue to store ISO timestamps. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type GovernanceRole = 'super_admin' | 'ops_admin' | 'operator' | 'auditor' | 'viewer';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'expired';

export type AuditResult = 'success' | 'failed' | 'denied';

export interface GovernanceActor {
  type: 'user' | 'system' | 'api';
  userId?: string;
  username?: string;
  displayName?: string;
  role?: string;
}

export interface GovernanceResource {
  type: string;
  id?: string;
  name?: string;
}

export interface GovernanceEvent {
  id?: string;
  timestamp: string;
  type: string;
  actor?: string;
  message: string;
}
