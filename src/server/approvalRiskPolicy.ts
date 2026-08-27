import type { RiskLevel } from '@/types/governance';
import type { ApprovalAction } from '@/server/repositories/approvalRepository';

export type ApprovalRiskAssessment = {
  level: RiskLevel;
  reasons: string[];
  policyId: string;
};

type RiskRule = Omit<ApprovalRiskAssessment, 'policyId'>;

/**
 * Server-owned risk catalog. Callers submit a supported action, never a risk level.
 * Unknown operations fail safe as high risk instead of relying on action-name guesses.
 */
const RISK_CATALOG: Readonly<Record<ApprovalAction, RiskRule>> = {
  ACCESS_REQUEST: { level: 'high', reasons: ['Changes an account authorization boundary'] },
  POLICY_CHANGE: { level: 'high', reasons: ['Changes live subscriber policy assignment'] },
  TRAFFIC_ADJUSTMENT: { level: 'high', reasons: ['Changes a charging balance'] },
  RATING_CREATE: { level: 'medium', reasons: ['Adds a charging rule without removing an existing rule'] },
  RATING_UPDATE: { level: 'high', reasons: ['Changes an active charging rule'] },
  RATING_DELETE: { level: 'critical', reasons: ['Removes an active charging rule'] },
  TARIFF_PLAN_MIGRATE: { level: 'critical', reasons: ['Moves multiple subscribers between tariff plans'] },
  PROFILE_RESTORE: { level: 'high', reasons: ['Restores a previous configuration snapshot'] },
  SYSTEM_HEAL: { level: 'high', reasons: ['Writes corrective state to a managed resource'] },
  SUBSCRIBER_BATCH_CREATE: { level: 'high', reasons: ['Creates multiple subscriber records'] },
  SUBSCRIBER_IMPORT: { level: 'critical', reasons: ['Imports or overwrites multiple subscriber records'] },
  SUBSCRIBER_BULK_DELETE: { level: 'critical', reasons: ['Deletes multiple subscriber records'] },
};

export const APPROVAL_RISK_POLICY_ID = 'approval-risk-v1';

export function assessApprovalRisk(action: ApprovalAction | string): ApprovalRiskAssessment {
  const rule = RISK_CATALOG[action as ApprovalAction];
  return rule
    ? { ...rule, reasons: [...rule.reasons], policyId: APPROVAL_RISK_POLICY_ID }
    : {
        level: 'high',
        reasons: ['Operation is not present in the approved risk catalog; fail-safe review is required'],
        policyId: APPROVAL_RISK_POLICY_ID,
      };
}

/** Explicit maker-checker policy: low/medium may self-review; high/critical may not. */
export function requiresIndependentReviewer(risk: RiskLevel): boolean {
  return risk === 'high' || risk === 'critical';
}

export function isSupportedApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === 'string' && Object.hasOwn(RISK_CATALOG, value);
}

export function supportedApprovalActions(): readonly ApprovalAction[] {
  return Object.keys(RISK_CATALOG) as ApprovalAction[];
}
