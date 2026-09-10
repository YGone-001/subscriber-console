import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { precheckSubscriberImsis } from '@/server/repositories/subscriberRepository';
import { getTariffPlan } from '@/server/repositories/ocsBillingRepository';
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
        return handlePrecheck(body, deps);
      }

      if (mode === 'import') {
        return handleImport(request, body, auth.auth, deps);
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

const SENSITIVE_KEYS = ['k', 'op', 'opc', 'amf', 'sqn'];

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
    return NextResponse.json({ error: validation.error }, { status: 400 });
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

  // Reject sensitive records
  const secretBearing = validation.value.some((record) =>
    SENSITIVE_KEYS.some((key) => record[key] !== undefined && String(record[key]).trim() !== '')
  );
  if (secretBearing) {
    return NextResponse.json({ error: 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED' }, { status: 422 });
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

  // Check for existing active approvals (simplified — production uses full active-change check)
  // This is handled by the approval creator in production

  if (!policy.requiresApproval) {
    // super_admin/root: Direct execution
    const result = await (deps.executeFrozenSubscriberImportV2 || executeFrozenSubscriberImportV2)(frozen) as Awaited<ReturnType<typeof executeFrozenSubscriberImportV2>>;
    const classification = classifyImportResult(result);

    // Business audit
    const auditResult = classification === 'SUCCESS' ? 'success' : 'failed';
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
      return NextResponse.json({
        error: 'SUBSCRIBER_IMPORT_FAILED_NO_MUTATION',
        code: 'SUBSCRIBER_IMPORT_FAILED_NO_MUTATION',
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
