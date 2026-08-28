import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { validateCurrentAccount } from '@/lib/accountSession';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { approvalActionEligibility } from '@/server/approvalWorkflow';
import {
  evaluateSubscriberOperationPolicy,
  prepareFrozenSubscriberBatchChange,
  SubscriberBatchGovernanceError,
  validateSubscriberBatchChangeRequest,
} from '@/server/subscriberOperationPolicy';
import { createApprovalRequest, listActiveSubscriberBatchApprovals } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

function payloadTargets(approval: { payload: Record<string, unknown> }) {
  const targets = Array.isArray(approval.payload.targets) ? approval.payload.targets : [];
  return targets.flatMap((value) => value && typeof value === 'object' && typeof (value as { imsi?: unknown }).imsi === 'string'
    ? [String((value as { imsi: string }).imsi)] : []);
}

function payloadFields(approval: { payload: Record<string, unknown> }) {
  return Array.isArray(approval.payload.fieldNames) ? approval.payload.fieldNames.filter((value): value is string => typeof value === 'string') : [];
}

async function existingBatchChange(fingerprint: string, imsis: string[], fields: string[]) {
  const active = await listActiveSubscriberBatchApprovals();
  const duplicate = active.find((approval) => approval.operationFingerprint === fingerprint);
  if (duplicate) return { duplicate };
  const requestedImsis = new Set(imsis);
  const requestedFields = new Set(fields);
  const conflict = active.find((approval) => {
    const targetOverlap = payloadTargets(approval).some((imsi) => requestedImsis.has(imsi));
    const fieldOverlap = payloadFields(approval).some((field) => requestedFields.has(field));
    return targetOverlap && fieldOverlap;
  });
  return conflict ? { conflict } : {};
}

export async function POST(request: Request) {
  const auth = requirePermission(request, 'subscribers.write');
  if (!auth.ok) return auth.response;
  const rate = await enforceRateLimit(`subscribers:batch-update:${auth.auth.user}`, 12, 60);
  if (!rate.ok) return rate.response;
  try {
    const input = validateSubscriberBatchChangeRequest(await request.json());
    const policy = evaluateSubscriberOperationPolicy(auth.auth, input);
    if (!policy.allowed) return NextResponse.json({ error: 'PERMISSION_DENIED', code: 'PERMISSION_DENIED' }, { status: 403 });
    // The policy deliberately has no root/super-admin exception.
    if (!policy.requiresApproval) return NextResponse.json({ error: 'APPROVAL_REQUIRED', code: 'APPROVAL_REQUIRED' }, { status: 409 });
    const frozen = await prepareFrozenSubscriberBatchChange(input);
    const existing = await existingBatchChange(frozen.operationFingerprint, input.imsis, frozen.fieldNames);
    if (existing.duplicate) {
      return NextResponse.json({ approval: { ...existing.duplicate, actions: approvalActionEligibility(existing.duplicate, auth.auth) }, requiresApproval: true, idempotent: true }, { status: 202 });
    }
    if (existing.conflict) return NextResponse.json({ error: 'ACTIVE_CHANGE_CONFLICT', code: 'ACTIVE_CHANGE_CONFLICT', approval: existing.conflict }, { status: 409 });
    const account = await validateCurrentAccount({ username: auth.auth.user, role: auth.auth.role, sv: auth.auth.sessionVersion });
    const actor = { type: 'user' as const, userId: account.userId, username: account.username, role: account.role };
    const sample = frozen.targets.slice(0, 25).map((target) => ({ imsi: target.imsi, before: target.before, after: target.after }));
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_BATCH_UPDATE', requester: account.username, requesterContext: actor,
      targetId: `subscriber-batch:${frozen.operationFingerprint}`, title: `Batch update ${frozen.targetCount} subscriber(s)`,
      description: `Governed core subscriber update for ${frozen.fieldNames.join(', ')}`,
      summary: `${frozen.targetCount} subscriber(s): ${frozen.fieldNames.join(', ')}`,
      operation: { resourceType: 'subscriber_batch', resourceId: frozen.operationFingerprint }, operationFingerprint: frozen.operationFingerprint,
      reason: input.reason, ticketId: input.ticketId, maintenanceWindow: input.maintenanceWindow,
      before: { targetCount: frozen.targetCount, fields: frozen.fieldNames, targets: sample },
      after: { targetCount: frozen.targetCount, fields: frozen.fieldNames, targets: sample.map((target) => ({ imsi: target.imsi, values: target.after })) },
      payload: frozen,
    });
    try {
      await writeAuditLog({ actor, module: 'approvals', action: 'approval.create',
        resource: { type: 'approval', id: approval.id, name: approval.changeId || approval.id }, targetId: `approval:${approval.id}`,
        approvalId: approval.id, riskLevel: approval.riskLevel, result: 'success', reason: input.reason,
        after: { status: approval.status, action: approval.action, targetCount: frozen.targetCount, fieldNames: frozen.fieldNames, operationFingerprint: frozen.operationFingerprint },
        metadata: { operation: policy.operation, policyId: policy.policyId, operationFingerprint: frozen.operationFingerprint, targetCount: frozen.targetCount },
        ...auditRequestContext(request),
      }, { failureMode: 'strict' });
    } catch {
      console.error('APPROVAL_AUDIT_PERSISTENCE_ALERT', { approvalId: approval.id, action: 'approval.create' });
      return NextResponse.json({ error: 'AUDIT_UNAVAILABLE', code: 'AUDIT_UNAVAILABLE', committed: true, approval }, { status: 503 });
    }
    return NextResponse.json({ approval: { ...approval, actions: approvalActionEligibility(approval, auth.auth) }, requiresApproval: true }, { status: 202 });
  } catch (error) {
    if (error instanceof SubscriberBatchGovernanceError) {
      return NextResponse.json({ error: error.code, code: error.code, details: error.details }, { status: error.code === 'SUBSCRIBER_NOT_FOUND' ? 404 : error.code === 'ACTIVE_CHANGE_CONFLICT' ? 409 : 400 });
    }
    if (error && typeof error === 'object' && (error as { code?: number }).code === 11000) {
      return NextResponse.json({ error: 'ACTIVE_CHANGE_CONFLICT', code: 'ACTIVE_CHANGE_CONFLICT' }, { status: 409 });
    }
    console.error('SUBSCRIBER_BATCH_APPROVAL_CREATE_FAILED', { code: error instanceof Error ? error.message : 'UNKNOWN' });
    return NextResponse.json({ error: 'APPROVAL_CREATE_FAILED', code: 'APPROVAL_CREATE_FAILED' }, { status: 503 });
  }
}
