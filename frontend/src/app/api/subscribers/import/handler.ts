import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { precheckSubscriberImsis } from '@/server/repositories/subscriberRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
import { listActiveSubscriberApprovals } from '@/server/repositories/approvalRepository';
import { validateImportRecords, validateImsiList } from '@/lib/subscriberValidation';
import { createHash } from 'node:crypto';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { validateCurrentAccount } from '@/lib/accountSession';
import { createGovernedApproval } from '@/server/approvalCreator';
import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import {
  prepareFrozenSubscriberImport,
  assertFrozenSubscriberImportV2,
  executeFrozenSubscriberImportV2,
  classifyImportResult,
  type FrozenSubscriberImportV2,
} from '@/server/subscriberSingleGovernance';
import { stable, hash } from '@/lib/subscriberContract';
import { createHash as createHashFn } from 'node:crypto';

export const dynamic = 'force-dynamic';

// --- DI seam for testing ---

export interface SubscriberImportDeps {
  requireCapability: typeof requireCapability;
  enforceRateLimit: typeof enforceRateLimit;
  validateImportRecords: typeof validateImportRecords;
  validateImsiList: typeof validateImsiList;
  validateCurrentAccount: typeof validateCurrentAccount;
  precheckSubscriberImsis: typeof precheckSubscriberImsis;
  getTariffPlan: typeof getTariffPlan;
  evaluateSubscriberOperationForActor: typeof evaluateSubscriberOperationForActor;
  createGovernedApproval: typeof createGovernedApproval;
  writeAuditLog: typeof writeAuditLog;
  prepareFrozenSubscriberImport: typeof prepareFrozenSubscriberImport;
  listActiveSubscriberApprovals: typeof listActiveSubscriberApprovals;
  executeFrozenSubscriberImportV2?: (frozen: unknown) => Promise<unknown>;
}

const productionDeps: SubscriberImportDeps = {
  requireCapability,
  enforceRateLimit,
  validateImportRecords,
  validateImsiList,
  validateCurrentAccount,
  precheckSubscriberImsis,
  getTariffPlan,
  evaluateSubscriberOperationForActor,
  createGovernedApproval,
  writeAuditLog,
  prepareFrozenSubscriberImport,
  listActiveSubscriberApprovals,
};

export function createSubscriberImportHandler(deps: SubscriberImportDeps = productionDeps) {
  return async function importHandler(request: Request) {
    try {
      const auth = deps.requireCapability(request, 'subscriber_write');
      if (!auth.ok) return auth.response;

      const rateLimit = await deps.enforceRateLimit(`subscribers:import:${auth.auth.user}`, 12, 60);
      if (!rateLimit.ok) return rateLimit.response;

      const { searchParams } = new URL(request.url);
      const mode = searchParams.get('mode') || 'precheck';
      const body = await request.json();

      if (mode === 'precheck') {
        return await handlePrecheck(body, deps);
      }

      if (mode === 'import') {
        return await handleImport(request, body, auth.auth, deps);
      }

      return NextResponse.json({ error: 'Invalid mode parameter' }, { status: 400 });
    } catch (error) {
      const errorMsg = (error as Error)?.message;
      if (errorMsg === 'INVALID_PLAN_ID') {
        return NextResponse.json({ error: 'Invalid plan_id format', code: 'INVALID_PLAN_ID' }, { status: 400 });
      }
      if (errorMsg === 'OCS_PLAN_NOT_FOUND') {
        return NextResponse.json({ error: 'Tariff plan not found', code: 'OCS_PLAN_NOT_FOUND' }, { status: 404 });
      }
      if (errorMsg === 'OCS_PLAN_DISABLED') {
        return NextResponse.json({ error: 'Tariff plan is disabled', code: 'OCS_PLAN_DISABLED' }, { status: 409 });
      }
      if (errorMsg === 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED') {
        return NextResponse.json({ error: 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED', code: 'SUBSCRIBER_IMPORT_PRECONDITION_CHANGED', mutationCommitted: false, partialMutation: false }, { status: 409 });
      }
      if (errorMsg === 'APPROVAL_SNAPSHOT_TOO_LARGE') {
        return NextResponse.json({ error: 'APPROVAL_SNAPSHOT_TOO_LARGE', code: 'APPROVAL_SNAPSHOT_TOO_LARGE' }, { status: 413 });
      }

      console.error('Import Error:', error);
      return NextResponse.json({ error: 'Internal server error during import' }, { status: 500 });
    }
  };
}

async function handlePrecheck(body: Record<string, unknown>, deps: SubscriberImportDeps) {
  const { imsiList } = body;
  const validation = deps.validateImsiList(imsiList);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const conflicts = await deps.precheckSubscriberImsis(validation.value);

  return NextResponse.json({
    total: conflicts.length,
    existing: conflicts.filter((item) => item.exists).length,
    newCount: conflicts.filter((item) => !item.exists).length,
    conflicts,
  });
}

const IMPORT_CONFLICT_ACTIONS = [
  'SUBSCRIBER_BATCH_CREATE', 'SUBSCRIBER_IMPORT', 'SUBSCRIBER_BULK_DELETE',
  'SUBSCRIBER_BATCH_UPDATE', 'SUBSCRIBER_UPDATE', 'SUBSCRIBER_DELETE',
];

type ActiveApprovalMatch = { type: 'duplicate'; approval: Record<string, unknown> } | { type: 'conflict'; approval: Record<string, unknown> };

function extractApprovalTargets(approval: { action: string; payload?: Record<string, unknown>; targetId?: string }): string[] {
  const payload = approval.payload || {};
  if (approval.action === 'SUBSCRIBER_UPDATE' || approval.action === 'SUBSCRIBER_DELETE') {
    if (typeof payload.imsi === 'string' && payload.imsi.length === 15) return [payload.imsi];
    return [];
  }
  // BATCH_UPDATE, BULK_DELETE, BATCH_CREATE, IMPORT: payload.targets[].imsi
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  return targets.map((t: Record<string, unknown>) => t.imsi).filter((i): i is string => typeof i === 'string');
}

async function findActiveImportConflicts(
  fingerprint: string,
  targets: Array<{ imsi: string; state: string }>,
  deps: SubscriberImportDeps,
): Promise<ActiveApprovalMatch | null> {
  const createImsis = new Set(targets.filter((t) => t.state === 'absent').map((t) => t.imsi));

  for (const action of IMPORT_CONFLICT_ACTIONS) {
    const active = await deps.listActiveSubscriberApprovals(action);
    for (const approval of active) {
      // Duplicate check: same fingerprint for IMPORT
      if (action === 'SUBSCRIBER_IMPORT' && approval.operationFingerprint === fingerprint) {
        return { type: 'duplicate', approval };
      }
      // Overlap check: any active change targeting same IMSIs we intend to create
      const existingTargets = extractApprovalTargets(approval);
      const hasOverlap = existingTargets.some((imsi) => createImsis.has(imsi));
      if (hasOverlap) {
        return { type: 'conflict', approval };
      }
    }
  }
  return null;
}

async function handleImport(
  request: Request,
  body: Record<string, unknown>,
  auth: { user: string; role: string; sessionVersion: number },
  deps: SubscriberImportDeps,
) {
  const { records, overwrite } = body;

  // Reject overwrite
  if (overwrite) {
    return NextResponse.json({ error: 'SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED' }, { status: 422 });
  }

  // Validate records
  const validation = deps.validateImportRecords(records);
  if (!validation.ok) {
    // Preserve SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED as 422 (validator is authority)
    if (validation.error === 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED') {
      return NextResponse.json(
        { error: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED', code: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED' },
        { status: 422 },
      );
    }
    return NextResponse.json({ error: 'INVALID_SUBSCRIBER_IMPORT_REQUEST', code: 'INVALID_SUBSCRIBER_IMPORT_REQUEST' }, { status: 400 });
  }

  // Validate tariff plans
  const planIds = Array.from(new Set(
    validation.value.map((record) => String(record.plan_id || 'plan_default_10gb').trim() || 'plan_default_10gb')
  ));
  for (const planId of planIds) {
    const plan = await deps.getTariffPlan(planId);
    if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
    if (plan.status === 'disabled') throw new Error('OCS_PLAN_DISABLED');
  }

  // Fresh actor validation
  const account = await deps.validateCurrentAccount({ username: auth.user, role: auth.role, sv: auth.sessionVersion });
  const freshActor = {
    type: 'user' as const,
    userId: account.userId,
    username: account.username,
    role: account.role,
  };

  // Evaluate governance
  const operation = SUBSCRIBER_OPERATIONS.IMPORT;
  const policy = deps.evaluateSubscriberOperationForActor(operation, freshActor.role);

  // Prepare frozen v2
  const frozen = await deps.prepareFrozenSubscriberImport(validation.value);

  // Active change protection — cross-action target overlap check
  const activeMatch = await findActiveImportConflicts(frozen.operationFingerprint, frozen.targets, deps);

  if (!policy.requiresApproval) {
    // super_admin/root: Direct execution — ANY active conflict → 409
    if (activeMatch) {
      return NextResponse.json({
        error: 'ACTIVE_CHANGE_CONFLICT',
        code: 'ACTIVE_CHANGE_CONFLICT',
        approval: activeMatch.approval,
      }, { status: 409 });
    }

    // Execute with strict business audit on every terminal outcome
    let result: Awaited<ReturnType<typeof executeFrozenSubscriberImportV2>>;
    try {
      result = await (deps.executeFrozenSubscriberImportV2 || executeFrozenSubscriberImportV2)(frozen) as typeof result;
    } catch (error) {
      // Executor threw — classify the zero-write failure and audit it
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

      // Business audit — strict, zero-write failure
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
            approvalRequired: false,
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
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({
          error: 'AUDIT_UNAVAILABLE',
          code: 'AUDIT_UNAVAILABLE',
          committed: false,
        }, { status: 503 });
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

    // Business audit — strict, with committed semantics
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
          approvalRequired: false,
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
      }, { failureMode: 'strict' });
    } catch {
      return NextResponse.json({
        error: 'AUDIT_UNAVAILABLE',
        code: 'AUDIT_UNAVAILABLE',
        committed: result.mutationCommitted,
      }, { status: 503 });
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
      // Zero inserts: distinguish precondition drift from storage failure
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
      requiresApproval: false,
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

  // operator/ops_admin: Approval path
  if (activeMatch) {
    if (activeMatch.type === 'duplicate') {
      return NextResponse.json({
        approval: activeMatch.approval,
        requiresApproval: true,
        idempotent: true,
      }, { status: 202 });
    }
    return NextResponse.json({
      error: 'ACTIVE_CHANGE_CONFLICT',
      code: 'ACTIVE_CHANGE_CONFLICT',
      approval: activeMatch.approval,
    }, { status: 409 });
  }

  const approval = await deps.createGovernedApproval({
    action: 'SUBSCRIBER_IMPORT',
    requester: auth.user,
    requesterContext: freshActor,
    targetId: 'subscriber:csv-import',
    summary: `Import ${validation.value.length} subscriber record(s)`,
    operation: { resourceType: 'subscriber_import', resourceId: frozen.summary.fileHash },
    operationFingerprint: frozen.operationFingerprint,
    before: { targetCount: frozen.targetCount, summary: frozen.summary },
    payload: frozen as unknown as Record<string, unknown>,
  }, freshActor);

  return NextResponse.json({
    approval,
    requiresApproval: true,
  }, { status: 202 });
}

// Production export
export const POST = createSubscriberImportHandler();
