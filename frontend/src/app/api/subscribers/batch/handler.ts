import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateBatchCreatePayload } from '@/lib/subscriberValidation';
import { validateCurrentAccount, AccountSessionError } from '@/lib/accountSession';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { precheckSubscriberRange } from '@/server/repositories/subscriberRepository';
import { writeAuditLog } from '@/lib/audit';
import {
  prepareFrozenBatchCreateV2,
  executeFrozenBatchCreate,
  classifyBatchResult,
  SubscriberBatchGovernanceError,
} from '@/server/subscriberBatchGovernance';

export const dynamic = 'force-dynamic';

export type BatchRouteDeps = {
  requireCapability: typeof requireCapability;
  enforceRateLimit: typeof enforceRateLimit;
  validateCurrentAccount: typeof validateCurrentAccount;
  evaluateSubscriberOperationForActor: typeof evaluateSubscriberOperationForActor;
  precheckSubscriberRange: typeof precheckSubscriberRange;
  prepareFrozenBatchCreateV2: typeof prepareFrozenBatchCreateV2;
  writeAuditLog: typeof writeAuditLog;
  executeFrozenBatchCreate: typeof executeFrozenBatchCreate;
};

const defaultBatchDeps: BatchRouteDeps = {
  requireCapability,
  enforceRateLimit,
  validateCurrentAccount,
  evaluateSubscriberOperationForActor,
  precheckSubscriberRange,
  prepareFrozenBatchCreateV2,
  writeAuditLog,
  executeFrozenBatchCreate,
};

export function createBatchCreateHandler(deps: BatchRouteDeps = defaultBatchDeps) {
  return async function POST(request: Request) {
    const auth = deps.requireCapability(request, 'subscriber_write');
    if (!auth.ok) return auth.response;

    const rate = await deps.enforceRateLimit(`batch-create:${auth.auth.user}`, 30, 60);
    if (!rate.ok) return rate.response;

    try {
      const body = await request.json();
      const validation = validateBatchCreatePayload(body);
      if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }

      // Fresh actor validation — fail closed
      const freshAccount = await deps.validateCurrentAccount(auth.auth);

      // Governance check from central registry
      const policy = deps.evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.BATCH_CREATE, freshAccount.normalizedRole);
      if (!policy.executable) {
        return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
      }

      // Prepare frozen snapshot
      const frozen = await deps.prepareFrozenBatchCreateV2({
        ...validation.value,
        trafficTotal: validation.value.trafficTotal === undefined ? undefined : Number(validation.value.trafficTotal),
        trafficBalance: validation.value.trafficBalance === undefined ? undefined : Number(validation.value.trafficBalance),
        smsTotal: validation.value.smsTotal === undefined ? undefined : Number(validation.value.smsTotal),
        smsBalance: validation.value.smsBalance === undefined ? undefined : Number(validation.value.smsBalance),
      });

      // Preflight conflict check
      const precheck = await deps.precheckSubscriberRange(frozen.startImsi, frozen.count);
      if (precheck.conflictCount > 0) {
        return NextResponse.json({
          error: 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED',
          conflictCount: precheck.conflictCount,
          conflictImsis: precheck.conflictImsis.slice(0, 20),
        }, { status: 409 });
      }

      // Direct execution
      const result = await deps.executeFrozenBatchCreate(frozen);

      // Centralized result classification
      const classification = classifyBatchResult(result.createdCount, result.failedCount);
      const auditResult = classification === 'SUCCESS' ? 'success' : 'failed';

      // Non-gating audit
      try {
        await deps.writeAuditLog({
          module: 'subscribers',
          action: 'BATCH_CREATE',
          targetId: `${frozen.expectedAbsentImsis[0]}~${frozen.expectedAbsentImsis[frozen.expectedAbsentImsis.length - 1]}`,
          actor: { type: 'user', username: freshAccount.username, role: freshAccount.normalizedRole },
          before: null,
          after: {
            startImsi: frozen.startImsi,
            count: frozen.count,
            createdCount: result.createdCount,
            failedCount: result.failedCount,
            partialMutation: result.partialMutation,
            classification,
            profileName: frozen.profile.requestedName,
            effectivePlanId: frozen.effectiveOcs.planId,
            trafficTotal: frozen.effectiveOcs.trafficTotal,
            trafficBalance: frozen.effectiveOcs.trafficBalance,
            smsTotal: frozen.effectiveOcs.smsTotal,
            smsBalance: frozen.effectiveOcs.smsBalance,
            fingerprint: frozen.operationFingerprint,
            governanceMode: 'DIRECT_GOVERNED',
            operation: 'SUBSCRIBER_BATCH_CREATE',
            actorRole: freshAccount.normalizedRole,
          },
          result: auditResult,
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            operation: 'SUBSCRIBER_BATCH_CREATE',
            actorRole: freshAccount.normalizedRole,
            classification,
            partialMutation: result.partialMutation,
          },
        }, { failureMode: 'best-effort' });
      } catch (auditErr) {
        console.warn('Batch create audit failed (non-gating):', auditErr);
      }

      // Zero-created failure — distinguish conflict vs non-conflict
      if (classification === 'FAILED_NO_MUTATION') {
        if (result.conflictImsis.length > 0 && result.subscriberFailedImsis.length === 0) {
          return NextResponse.json({
            error: 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED',
            conflictCount: result.conflictImsis.length,
            conflictImsis: result.conflictImsis.slice(0, 20),
            partialMutation: false,
          }, { status: 409 });
        }
        return NextResponse.json({
          error: 'SUBSCRIBER_BATCH_CREATE_FAILED',
          code: 'SUBSCRIBER_BATCH_CREATE_FAILED',
          partialMutation: false,
        }, { status: 500 });
      }

      // Partial write
      if (classification === 'PARTIAL_WRITE') {
        return NextResponse.json({
          error: 'SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE',
          code: 'SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE',
          partialMutation: true,
          createdCount: result.createdCount,
          failedCount: result.failedCount,
          startImsi: frozen.startImsi,
          count: frozen.count,
          conflictImsis: result.conflictImsis,
          subscriberFailedImsis: result.subscriberFailedImsis,
          ocsFailedImsis: result.ocsFailedImsis,
        }, { status: 409 });
      }

      return NextResponse.json({
        outcome: 'executed',
        message: 'Batch creation completed successfully',
        createdCount: result.createdCount,
        startImsi: frozen.startImsi,
        count: frozen.count,
      }, { status: 201 });
    } catch (error) {
      if (error instanceof SubscriberBatchGovernanceError) {
        return NextResponse.json({ error: error.code, code: error.code }, { status: error.code === 'TARIFF_PLAN_NOT_FOUND' ? 404 : 400 });
      }
      if (error instanceof AccountSessionError) {
        const statusMap: Record<string, number> = { AUTH_INVALID_TOKEN: 401, ACCOUNT_NOT_FOUND: 401, ACCOUNT_DISABLED: 403, ACCOUNT_LOCKED: 403, SESSION_REVOKED: 403 };
        return NextResponse.json({ error: error.code }, { status: statusMap[error.code] || 500 });
      }
      if (error && typeof error === 'object' && (error as { code?: number }).code === 11000) {
        return NextResponse.json({ error: 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED' }, { status: 409 });
      }
      console.error('Error in batch create:', error);
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
  };
}

export const POST = createBatchCreateHandler();
