import { logAudit } from '@/lib/audit';
import { validateImsi, validatePolicyChangePayload, validateTrafficAdjustmentPayload } from '@/lib/subscriberValidation';
import type { ApprovalDocument } from '@/server/repositories/approvalRepository';
import { adjustOcsTrafficBalance, changeOcsPolicyForSubscribers } from '@/server/repositories/ocsBillingRepository';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function auditActionForMode(mode: string) {
  if (mode === 'recharge') return 'TRAFFIC_RECHARGE';
  if (mode === 'reset') return 'TRAFFIC_RESET';
  return 'TRAFFIC_ADJUST';
}

export async function executeApproval(approval: ApprovalDocument, request: Request) {
  if (approval.action === 'POLICY_CHANGE') {
    const validation = validatePolicyChangePayload(approval.payload);
    if (!validation.ok) throw new Error(validation.error);

    const result = await changeOcsPolicyForSubscribers(validation.value);
    logAudit(
      'UPDATE',
      `policy:${result.planId}`,
      { approvalId: approval.id, status: 'approved' },
      {
        approvalId: approval.id,
        imsiList: validation.value.imsiList,
        requested: result.requested,
        subscriberModified: result.subscriberModified,
        balanceModified: result.balanceModified,
        status: result.status,
        resetBalances: result.resetBalances,
      },
      request
    );

    return result;
  }

  if (approval.action === 'TRAFFIC_ADJUSTMENT') {
    const payload = asRecord(approval.payload);
    const imsiResult = validateImsi(payload.imsi);
    if (!imsiResult.ok) throw new Error(imsiResult.error);

    const validation = validateTrafficAdjustmentPayload(payload.adjustment);
    if (!validation.ok) throw new Error(validation.error);

    const result = await adjustOcsTrafficBalance(imsiResult.value, validation.value);
    logAudit(
      auditActionForMode(result.mode),
      imsiResult.value,
      result.before,
      {
        ...result.after,
        approvalId: approval.id,
        mode: result.mode,
        reason: result.reason,
      },
      request
    );

    return result;
  }

  throw new Error('Unsupported approval action');
}
