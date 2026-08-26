import type { ApprovalStatus, RiskLevel } from '@/types/governance';

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const satisfies readonly RiskLevel[];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && RISK_LEVELS.some((risk) => risk === value);
}

export function requiresApproval(risk: RiskLevel): boolean {
  return risk === 'high' || risk === 'critical';
}

/** Display adapter only: do not rename the legacy persisted status in Phase 1. */
export function normalizeApprovalStatus(value: unknown): ApprovalStatus | null {
  if (value === 'executed') return 'completed';
  switch (value) {
    case 'pending': case 'approved': case 'rejected': case 'cancelled':
    case 'executing': case 'completed': case 'failed': case 'expired':
      return value;
    default:
      return null;
  }
}
