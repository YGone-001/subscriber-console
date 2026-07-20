import { logAudit } from '@/lib/audit';
import { validateImsi, validatePolicyChangePayload, validateTrafficAdjustmentPayload } from '@/lib/subscriberValidation';
import type { ApprovalDocument } from '@/server/repositories/approvalRepository';
import { adjustOcsTrafficBalance, changeOcsPolicyForSubscribers } from '@/server/repositories/ocsBillingRepository';
import { createRating, deleteRating, updateRating } from '@/server/repositories/ratingRepository';

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

  if (approval.action === 'RATING_CREATE') {
    if (approval.payload.rating_group_id === undefined || approval.payload.rating_group_id === null || approval.payload.rating_group_id === '') {
      throw new Error('rating_group_id is required');
    }
    const result = await createRating(approval.payload as { rating_group_id: unknown } & Record<string, unknown>);
    logAudit('CREATE', `rating:${result.rating_group_id}`, null, { ...result, approvalId: approval.id }, request);
    return result;
  }

  if (approval.action === 'RATING_UPDATE') {
    const payload = asRecord(approval.payload);
    const id = String(payload.id || '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid rating ID format');

    const result = await updateRating(id, asRecord(payload.changes));
    logAudit('UPDATE', `rating:${id}`, { approvalId: approval.id }, { ...result, approvalId: approval.id }, request);
    return result;
  }

  if (approval.action === 'RATING_DELETE') {
    const payload = asRecord(approval.payload);
    const id = String(payload.id || '');
    if (!/^\d+$/.test(id)) throw new Error('Invalid rating ID format');

    const result = await deleteRating(id);
    if (!result.deleted) {
      throw new Error(`Cannot delete: Rating group is currently used by ${result.references.count} subscribers`);
    }

    logAudit('DELETE', `rating:${id}`, { id, approvalId: approval.id }, null, request);
    return result;
  }

  throw new Error('Unsupported approval action');
}
