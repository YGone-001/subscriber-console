import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { precheckSubscriberImsis } from '@/server/repositories/subscriberRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { validateImportRecords, validateImsiList } from '@/lib/subscriberValidation';
import { validateCurrentAccount } from '@/lib/accountSession';
import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import {
  prepareFrozenSubscriberImport,
  assertFrozenSubscriberImportV2,
  executeFrozenSubscriberImportV2,
  classifyImportResult,
} from '@/server/subscriberSingleGovernance';

export const dynamic = 'force-dynamic';

export interface SubscriberImportDeps {
  requireCapability: typeof requireCapability;
  enforceRateLimit: typeof enforceRateLimit;
  validateImportRecords: typeof validateImportRecords;
  validateImsiList: typeof validateImsiList;
  validateCurrentAccount: typeof validateCurrentAccount;
  precheckSubscriberImsis: typeof precheckSubscriberImsis;
  getTariffPlan: typeof getTariffPlan;
  prepareFrozenSubscriberImport: typeof prepareFrozenSubscriberImport;
  assertFrozenSubscriberImportV2: typeof assertFrozenSubscriberImportV2;
  executeFrozenSubscriberImportV2?: typeof executeFrozenSubscriberImportV2;
  writeAuditLog: typeof writeAuditLog;
}

const defaultDeps: SubscriberImportDeps = {
  requireCapability,
  enforceRateLimit,
  validateImportRecords,
  validateImsiList,
  validateCurrentAccount,
  precheckSubscriberImsis,
  getTariffPlan,
  prepareFrozenSubscriberImport,
  assertFrozenSubscriberImportV2,
  writeAuditLog,
};

export function createSubscriberImportHandler(deps: SubscriberImportDeps = defaultDeps) {
  return async function POST(request: Request) {
    const auth = deps.requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rate = await deps.enforceRateLimit(`subscriber-import:${auth.auth.user}`, 10, 60);
    if (!rate.ok) return rate.response;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'INVALID_JSON_BODY', code: 'INVALID_JSON_BODY' }, { status: 400 });
    }

    try {
      return await handleImport(request, body, auth.auth, deps);
    } catch (error) {
      if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
        return NextResponse.json({ error: 'OCS_PLAN_NOT_FOUND', code: 'OCS_PLAN_NOT_FOUND' }, { status: 404 });
      }
      if (error instanceof Error && error.message === 'OCS_PLAN_DISABLED') {
        return NextResponse.json({ error: 'OCS_PLAN_DISABLED', code: 'OCS_PLAN_DISABLED' }, { status: 409 });
      }
      return NextResponse.json({ error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR' }, { status: 500 });
    }
  };
}

async function handleImport(
  request: Request,
  body: Record<string, unknown>,
  auth: { user: string; role: string; sessionVersion: number },
  deps: SubscriberImportDeps,
) {
  const { records, overwrite } = body;

  if (overwrite) {
    return NextResponse.json({ error: 'SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED' }, { status: 422 });
  }

  const validation = deps.validateImportRecords(records);
  if (!validation.ok) {
    if (validation.error === 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED') {
      return NextResponse.json(
        { error: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED', code: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED' },
        { status: 422 },
      );
    }
    return NextResponse.json({ error: 'INVALID_SUBSCRIBER_IMPORT_REQUEST', code: 'INVALID_SUBSCRIBER_IMPORT_REQUEST' }, { status: 400 });
  }

  const planIds = Array.from(new Set(
    validation.value.map((record) => String(record.plan_id || 'plan_default_10gb').trim() || 'plan_default_10gb')
  ));
  for (const planId of planIds) {
    const plan = await deps.getTariffPlan(planId);
    if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
    if (plan.status === 'disabled') throw new Error('OCS_PLAN_DISABLED');
  }

  const account = await deps.validateCurrentAccount({ username: auth.user, role: auth.role, sv: auth.sessionVersion });
  const freshActor = {
    type: 'user' as const,
    userId: account.userId,
    username: account.username,
    role: account.role,
  };

  const frozen = await deps.prepareFrozenSubscriberImport(validation.value);

  // Direct execution
  let result: Awaited<ReturnType<typeof executeFrozenSubscriberImportV2>>;
  try {
    result = await (deps.executeFrozenSubscriberImportV2 || executeFrozenSubscriberImportV2)(frozen) as typeof result;
  } catch (error) {
    const isPrecondition = (error as Error)?.message === 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED';
    const zeroWriteResult = {
      requested: frozen.targetCount,
      intendedCreateCount: frozen.summary.createCount,
      createdImsis: [] as string[],
      skippedImsis: [] as string[],
      conflictImsis: isPrecondition ? frozen.targets.filter((t) => t.state === 'absent').map((t) => t.imsi) : [] as string[],
      failedImsis: isPrecondition ? [] as string[] : frozen.targets.filter((t) => t.state === 'absent').map((t) => t.imsi),
      ocsProvisionedImsis: [] as string[],
      ocsProvisioningFailedImsis: [] as string[],
      createdCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: frozen.operationFingerprint,
    };

    try {
      await deps.writeAuditLog({
        actor: freshActor,
        module: 'subscribers',
        action: 'subscriber.import',
        resource: { type: 'subscriber_import', id: 'csv-import' },
        targetId: 'subscriber:csv-import',
        riskLevel: 'high',
        result: 'failed',
        metadata: {
          governanceMode: 'DIRECT_GOVERNED',
          actorRole: freshActor.role,
          risk: 'high',
          requested: zeroWriteResult.requested,
          intendedCreateCount: zeroWriteResult.intendedCreateCount,
          createdCount: 0,
          skipCount: 0,
          conflictCount: zeroWriteResult.conflictImsis.length,
          failedCount: zeroWriteResult.failedImsis.length,
          ocsProvisioningFailureCount: 0,
          fileHash: frozen.summary.fileHash,
          operationFingerprint: frozen.operationFingerprint,
          classification: 'FAILED_NO_MUTATION',
          partialMutation: false,
          mutationCommitted: false,
        },
        ...auditRequestContext(request),
      }, { failureMode: 'best-effort' });
    } catch (auditErr) {
      console.warn('Import audit write failed (non-gating):', auditErr);
    }

    if (isPrecondition) {
      return NextResponse.json({
        error: 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED',
        code: 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED',
        requested: frozen.targetCount,
        imported: 0,
        skipped: 0,
        failed: 0,
        importedImsis: [],
        failedImsis: [],
        ocsProvisioningFailedImsis: [],
        partialMutation: false,
        mutationCommitted: false,
      }, { status: 409 });
    }
    return NextResponse.json({
      error: 'SUBSCRIBER_IMPORT_FAILED',
      code: 'SUBSCRIBER_IMPORT_FAILED',
      requested: frozen.targetCount,
      imported: 0,
      skipped: 0,
      failed: frozen.summary.createCount,
      importedImsis: [],
      failedImsis: frozen.targets.filter((t) => t.state === 'absent').map((t) => t.imsi),
      ocsProvisioningFailedImsis: [],
      partialMutation: false,
      mutationCommitted: false,
    }, { status: 500 });
  }

  const classification = classifyImportResult(result);
  const auditResult = classification === 'SUCCESS' ? 'success' : 'failed';
  try {
    await deps.writeAuditLog({
      actor: freshActor,
      module: 'subscribers',
      action: 'subscriber.import',
      resource: { type: 'subscriber_import', id: 'csv-import' },
      targetId: 'subscriber:csv-import',
      riskLevel: 'high',
      result: auditResult,
      metadata: {
        governanceMode: 'DIRECT_GOVERNED',
        actorRole: freshActor.role,
        risk: 'high',
        requested: result.requested,
        intendedCreateCount: result.intendedCreateCount,
        createdCount: result.createdCount,
        skipCount: result.skippedImsis.length,
        conflictCount: result.conflictImsis.length,
        failedCount: result.failedImsis.length,
        ocsProvisioningFailureCount: result.ocsProvisioningFailedImsis.length,
        fileHash: frozen.summary.fileHash,
        operationFingerprint: frozen.operationFingerprint,
        classification,
        partialMutation: result.partialMutation,
        mutationCommitted: result.mutationCommitted,
      },
      ...auditRequestContext(request),
    }, { failureMode: 'best-effort' });
  } catch (auditErr) {
    console.warn('Import audit write failed (non-gating):', auditErr);
  }

  if (classification === 'PARTIAL_WRITE') {
    return NextResponse.json({
      error: 'SUBSCRIBER_IMPORT_PARTIAL_WRITE',
      code: 'SUBSCRIBER_IMPORT_PARTIAL_WRITE',
      requested: result.requested,
      imported: result.createdCount,
      skipped: result.skippedImsis.length,
      failed: result.failedImsis.length,
      importedImsis: result.createdImsis,
      failedImsis: result.failedImsis,
      ocsProvisioningFailedImsis: result.ocsProvisioningFailedImsis,
      partialMutation: true,
      mutationCommitted: true,
    }, { status: 409 });
  }

  if (classification === 'FAILED_NO_MUTATION') {
    if (result.conflictImsis.length > 0) {
      return NextResponse.json({
        error: 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED',
        code: 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED',
        requested: result.requested,
        imported: result.createdCount,
        skipped: result.skippedImsis.length,
        failed: result.failedImsis.length,
        importedImsis: result.createdImsis,
        failedImsis: result.failedImsis,
        ocsProvisioningFailedImsis: result.ocsProvisioningFailedImsis,
        partialMutation: false,
        mutationCommitted: false,
      }, { status: 409 });
    }
    return NextResponse.json({
      error: 'SUBSCRIBER_IMPORT_FAILED',
      code: 'SUBSCRIBER_IMPORT_FAILED',
      requested: result.requested,
      imported: result.createdCount,
      skipped: result.skippedImsis.length,
      failed: result.failedImsis.length,
      importedImsis: result.createdImsis,
      failedImsis: result.failedImsis,
      ocsProvisioningFailedImsis: result.ocsProvisioningFailedImsis,
      partialMutation: false,
      mutationCommitted: false,
    }, { status: 500 });
  }

  return NextResponse.json({
    outcome: 'executed',
    message: 'Subscribers imported successfully',
    result: {
      requested: result.requested,
      imported: result.createdCount,
      skipped: result.skippedImsis.length,
      failed: result.failedImsis.length,
      importedImsis: result.createdImsis,
      failedImsis: result.failedImsis,
      ocsProvisioningFailedImsis: result.ocsProvisioningFailedImsis,
    },
  });
}

export const POST = createSubscriberImportHandler();
