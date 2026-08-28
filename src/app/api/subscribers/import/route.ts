import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import { precheckSubscriberImsis } from '@/server/repositories/subscriberRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { validateImportRecords, validateImsiList } from '@/lib/subscriberValidation';
import { createHash } from 'node:crypto';
import { evaluateSubscriberOperation, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

export const dynamic = 'force-dynamic';

async function validateImportPlanIds(records: Record<string, unknown>[]) {
  const planIds = Array.from(new Set(
    records.map((record) => String(record.plan_id || 'plan_default_10gb').trim() || 'plan_default_10gb')
  ));

  for (const planId of planIds) {
    const plan = await getTariffPlan(planId);
    if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
    if (plan.status === 'disabled') throw new Error('OCS_PLAN_DISABLED');
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`subscribers:import:${auth.auth.user}`, 12, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode') || 'precheck';
    const body = await request.json();

    if (mode === 'precheck') {
      const { imsiList } = body;
      const validation = validateImsiList(imsiList);
      if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

      const conflicts = await precheckSubscriberImsis(validation.value);

      return NextResponse.json({
        total: conflicts.length,
        existing: conflicts.filter((item) => item.exists).length,
        newCount: conflicts.filter((item) => !item.exists).length,
        conflicts,
      });
    }

    if (mode === 'import') {
      const { records, overwrite } = body;
      const validation = validateImportRecords(records);
      if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
      await validateImportPlanIds(validation.value);
      const secretBearing = validation.value.some((record) => ['k', 'op', 'opc', 'amf', 'sqn'].some((key) => record[key] !== undefined && String(record[key]).trim() !== ''));
      if (secretBearing) return NextResponse.json({ error: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED' }, { status: 422 });
      const imsis = validation.value.map((record) => String(record.imsi || '').trim()).filter(Boolean);
      const precheck = await precheckSubscriberImsis(imsis);
      const existing = precheck.filter((item) => item.exists).map((item) => item.imsi);
      // Replace-based CSV import would rebuild Open5GS security from the row.
      // Until a dedicated encrypted staged-secret facility exists it is disabled
      // rather than creating an approval that cannot safely execute.
      if (overwrite) return NextResponse.json({ error: 'SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED' }, { status: 422 });
      const operation = SUBSCRIBER_OPERATIONS.IMPORT;
      const policy = evaluateSubscriberOperation(operation);
      if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
      const normalizedPayload = { version: 'subscriber-import-v1', records: validation.value, overwrite: !!overwrite, summary: { rowCount: validation.value.length, createCount: imsis.length - existing.length, updateCount: overwrite ? existing.length : 0, conflictCount: existing.length, fieldNames: Array.from(new Set(validation.value.flatMap((record) => Object.keys(record))).values()).sort(), fileHash: createHash('sha256').update(JSON.stringify(validation.value)).digest('hex') } };

      const approval = await createApprovalRequest({
        action: 'SUBSCRIBER_IMPORT', requester: auth.auth.user,
        targetId: 'subscriber:csv-import', summary: `Import ${validation.value.length} subscriber record(s)${overwrite ? ' with overwrite' : ''}`,
        operation: { resourceType: 'subscriber_import', resourceId: normalizedPayload.summary.fileHash },
        operationFingerprint: createHash('sha256').update(JSON.stringify({ action: operation, targets: imsis.sort(), fileHash: normalizedPayload.summary.fileHash })).digest('hex'),
        payload: normalizedPayload,
      });
      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before subscriber import', approval }, { status: 202 });
    }

    return NextResponse.json({ error: 'Invalid mode parameter' }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_DISABLED') {
      return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
    }

    console.error('Import Error:', error);
    return NextResponse.json({ error: 'Internal server error during import' }, { status: 500 });
  }
}
