import { NextResponse } from 'next/server';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { validateBatchCreatePayload } from '@/lib/subscriberValidation';
import { validateCurrentAccount, AccountSessionError } from '@/lib/accountSession';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';
import { precheckSubscriberRange } from '@/server/repositories/subscriberRepository';
import { writeAuditLog } from '@/lib/audit';
import { createGovernedApproval, ApprovalCreationError } from '@/server/approvalCreator';
import {
  prepareFrozenBatchCreateV2,
  executeFrozenBatchCreate,
  classifyBatchResult,
  SubscriberBatchGovernanceError,
} from '@/server/subscriberBatchGovernance';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:batch:${auth.auth.user}`, 10, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const validation = validateBatchCreatePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    const payload = validation.value;

    // Fresh actor validation — fail closed
    const freshAccount = await validateCurrentAccount(auth.auth);

    // Actor-aware governance
    const policy = evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.BATCH_CREATE, freshAccount.normalizedRole);
    if (!policy.executable) {
      return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });
    }

    // Prepare frozen v2
    const frozen = await prepareFrozenBatchCreateV2({
      startImsi: payload.startImsi,
      count: payload.count,
      trafficTotal: payload.trafficTotal as number | undefined,
      trafficBalance: payload.trafficBalance as number | undefined,
      smsTotal: payload.smsTotal as number | undefined,
      smsBalance: payload.smsBalance as number | undefined,
      profileName: payload.profileName,
      planId: payload.planId,
    });

    // Request-time precheck — before Approval or direct mutation
    const precheck = await precheckSubscriberRange(payload.startImsi, payload.count);
    if (precheck.conflictCount > 0) {
      return NextResponse.json({
        error: 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED',
        conflictCount: precheck.conflictCount,
        conflictImsis: precheck.conflictImsis.slice(0, 20),
      }, { status: 409 });
    }

    if (policy.governanceMode === 'DIRECT_GOVERNED') {
      // super_admin/root direct execution
      const result = await executeFrozenBatchCreate(frozen);

      // Centralized result classification
      const classification = classifyBatchResult(result.createdCount, result.failedCount);

      // Zero-created failure — distinguish conflict vs non-conflict (PART I)
      if (classification === 'FAILED_NO_MUTATION') {
        if (result.conflictImsis.length > 0 && result.subscriberFailedImsis.length === 0) {
          // All failures are duplicates
          return NextResponse.json({
            error: 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED',
            conflictCount: result.conflictImsis.length,
            conflictImsis: result.conflictImsis.slice(0, 20),
            partialMutation: false,
          }, { status: 409 });
        }
        // Non-conflict storage failure
        return NextResponse.json({
          error: 'SUBSCRIBER_BATCH_CREATE_FAILED',
          code: 'SUBSCRIBER_BATCH_CREATE_FAILED',
          partialMutation: false,
        }, { status: 500 });
      }

      // Audit result classification (PART L)
      const auditResult = classification === 'SUCCESS' ? 'success' : 'failed';
      const committed = result.createdCount > 0;

      // Strict business audit
      try {
        await writeAuditLog({
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
            approvalRequired: false,
            operation: 'SUBSCRIBER_BATCH_CREATE',
            actorRole: freshAccount.normalizedRole,
          },
          result: auditResult,
          metadata: {
            governanceMode: 'DIRECT_GOVERNED',
            approvalRequired: false,
            operation: 'SUBSCRIBER_BATCH_CREATE',
            actorRole: freshAccount.normalizedRole,
            classification,
            partialMutation: result.partialMutation,
          },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({ error: 'AUDIT_UNAVAILABLE', code: 'AUDIT_UNAVAILABLE', committed }, { status: 503 });
      }

      // Partial write (PART K)
      if (classification === 'PARTIAL_WRITE') {
        return NextResponse.json({
          error: 'SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE',
          code: 'SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE',
          partialMutation: true,
          result: {
            createdImsis: result.createdImsis,
            failedImsis: result.failedImsis,
            metrics: result.metrics,
          },
        }, { status: 409 });
      }

      // Full success
      return NextResponse.json({
        outcome: 'executed',
        message: 'Subscribers created successfully',
        result: {
          createdImsis: result.createdImsis,
          failedImsis: result.failedImsis,
          metrics: result.metrics,
        },
        requiresApproval: false,
      }, { status: 201 });
    }

    // operator/ops_admin → approval (PART G, H)
    const actor = { type: 'user' as const, username: freshAccount.username, role: freshAccount.normalizedRole };
    try {
      const approval = await createGovernedApproval({
        action: 'SUBSCRIBER_BATCH_CREATE',
        requester: freshAccount.username,
        requesterContext: actor,
        targetId: `subscriber:batch:${payload.startImsi}`,
        summary: `Batch create ${payload.count} subscriber(s) from ${payload.startImsi}`,
        payload: frozen,
        operation: { resourceType: 'subscriber_batch', resourceId: payload.startImsi },
        operationFingerprint: frozen.operationFingerprint,
      }, actor);

      return NextResponse.json(
        { outcome: 'approval_required', message: 'Approval required before batch subscriber creation', approval, requiresApproval: true },
        { status: 202 }
      );
    } catch (error) {
      // PART F: Approval audit failure — committed=true, approval retained
      if (error instanceof ApprovalCreationError) {
        return NextResponse.json({
          error: 'AUDIT_UNAVAILABLE',
          code: 'AUDIT_UNAVAILABLE',
          committed: true,
          approval: error.approval,
        }, { status: 503 });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SubscriberBatchGovernanceError) {
      const statusMap: Record<string, number> = {
        INVALID_SUBSCRIBER_BATCH_CREATE_PAYLOAD: 400,
        IMSI_RANGE_OVERFLOW: 400,
        SUBSCRIBER_CREATE_PRECONDITION_CHANGED: 409,
        SUBSCRIBER_BATCH_PROFILE_PRECONDITION_CHANGED: 409,
      };
      const status = statusMap[error.code] || 500;
      const body: Record<string, unknown> = { error: error.code, code: error.code };
      if (error.details) Object.assign(body, error.details);
      return NextResponse.json(body, { status });
    }
    if (error instanceof AccountSessionError) {
      const statusMap: Record<string, number> = { AUTH_INVALID_TOKEN: 401, ACCOUNT_NOT_FOUND: 401, ACCOUNT_DISABLED: 403, ACCOUNT_LOCKED: 403, SESSION_REVOKED: 403 };
      return NextResponse.json({ error: error.code }, { status: statusMap[error.code] || 500 });
    }
    if (error instanceof Error && error.message === 'IMSI_RANGE_OVERFLOW') {
      return NextResponse.json({ error: 'Generated IMSI range exceeds 15 digits' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'INVALID_PLAN_ID') {
      return NextResponse.json({ error: 'Invalid plan_id format' }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_NOT_FOUND') {
      return NextResponse.json({ error: 'Tariff plan not found' }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'OCS_PLAN_DISABLED') {
      return NextResponse.json({ error: 'Tariff plan is disabled' }, { status: 409 });
    }

    console.error('Error in batch creation:', error);
    return NextResponse.json({ error: 'Batch creation failed' }, { status: 500 });
  }
}
