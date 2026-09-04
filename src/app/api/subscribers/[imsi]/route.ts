import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  findSubscriberLegacyState,
} from '@/server/repositories/subscriberRepository';
import { getUser } from '@/server/repositories/userRepository';
import { validateImsi, validateSubscriberUpdatePayload } from '@/lib/subscriberValidation';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import {
  prepareFrozenSubscriberDelete,
  prepareFrozenSubscriberUpdate,
  executeFrozenSubscriberUpdate,
  executeFrozenSubscriberDelete,
  SubscriberGovernanceError,
} from '@/server/subscriberSingleGovernance';
import { evaluateSubscriberOperation, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

function isDirectExecution(role: string | undefined): boolean {
  return role === 'super_admin' || role === 'root';
}

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ imsi: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:detail:${auth.auth.user}`, 180, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const state = await findSubscriberLegacyState(imsi);
    if (!state) {
      return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }

    return NextResponse.json(state);
  } catch (error) {
    console.error('Error fetching subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:delete:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const policy = evaluateSubscriberOperation(SUBSCRIBER_OPERATIONS.DELETE);
    if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });

    const frozen = await prepareFrozenSubscriberDelete(imsi);

    // Fresh actor validation — fail closed
    const freshAccount = await getUser(auth.auth.user);
    if (!freshAccount) return NextResponse.json({ error: 'User account not found' }, { status: 401 });
    if (freshAccount.status === 'locked') return NextResponse.json({ error: 'Account is locked' }, { status: 403 });
    if (freshAccount.status !== 'active') return NextResponse.json({ error: 'Account is disabled' }, { status: 403 });

    const directExecution = isDirectExecution(freshAccount.role);

    if (directExecution) {
      // Super Admin/root: DIRECT_GOVERNED — execute immediately, no approval
      const result = await executeFrozenSubscriberDelete(frozen);
      try {
        await writeAuditLog({
          module: 'subscribers', action: 'DELETE', targetId: imsi,
          actor: { type: 'user', username: auth.auth.user, role: freshAccount.role },
          before: frozen.before, after: { deleted: true, imsi },
          result: 'success',
          metadata: { governanceMode: 'DIRECT_GOVERNED', approvalRequired: false, operation: 'SUBSCRIBER_DELETE', actorRole: freshAccount.role },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({ error: 'AUDIT_UNAVAILABLE', code: 'AUDIT_UNAVAILABLE', committed: true }, { status: 503 });
      }
      return NextResponse.json({ outcome: 'executed', message: 'Subscriber deleted successfully', imsi }, { status: 200 });
    }

    // Normal operator/ops_admin: APPROVAL_GOVERNED — create approval
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_DELETE', requester: auth.auth.user, targetId: imsi,
      summary: `Delete subscriber ${imsi}`, operation: { resourceType: 'subscriber', resourceId: imsi },
      operationFingerprint: frozen.operationFingerprint, before: frozen.before,
      payload: frozen as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before subscriber deletion', approval }, { status: 202 });
  } catch (error) {
    if (error instanceof SubscriberGovernanceError && error.code === 'SUBSCRIBER_NOT_FOUND') return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    console.error('Error deleting subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { imsi } = await params;
  const auth = requireCapability(request, 'subscriber_write');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`subscribers:update:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const imsiResult = validateImsi(imsi);
  if (!imsiResult.ok) return NextResponse.json({ error: imsiResult.error }, { status: 400 });

  try {
    const body = await request.json();
    const validation = validateSubscriberUpdatePayload(body);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    const policy = evaluateSubscriberOperation(SUBSCRIBER_OPERATIONS.UPDATE);
    if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });

    const frozen = await prepareFrozenSubscriberUpdate(imsi, {
      sub4G: body.sub4G,
      auth4G: body.auth4G,
      ocsTraffic: body.ocsTraffic,
    });

    // Fresh actor validation — fail closed
    const freshAccount = await getUser(auth.auth.user);
    if (!freshAccount) return NextResponse.json({ error: 'User account not found' }, { status: 401 });
    if (freshAccount.status === 'locked') return NextResponse.json({ error: 'Account is locked' }, { status: 403 });
    if (freshAccount.status !== 'active') return NextResponse.json({ error: 'Account is disabled' }, { status: 403 });

    const directExecution = isDirectExecution(freshAccount.role);

    if (directExecution) {
      // Super Admin/root: DIRECT_GOVERNED — execute immediately, no approval
      const result = await executeFrozenSubscriberUpdate(frozen);
      try {
        await writeAuditLog({
          module: 'subscribers', action: 'UPDATE', targetId: imsi,
          actor: { type: 'user', username: auth.auth.user, role: freshAccount.role },
          before: frozen.before, after: result.after,
          result: 'success',
          metadata: { governanceMode: 'DIRECT_GOVERNED', approvalRequired: false, operation: 'SUBSCRIBER_UPDATE', actorRole: freshAccount.role },
        }, { failureMode: 'strict' });
      } catch {
        return NextResponse.json({ error: 'AUDIT_UNAVAILABLE', code: 'AUDIT_UNAVAILABLE', committed: true }, { status: 503 });
      }
      return NextResponse.json({ outcome: 'executed', message: 'Subscriber updated successfully', imsi }, { status: 200 });
    }

    // Normal operator/ops_admin: APPROVAL_GOVERNED — create approval
    const approval = await createApprovalRequest({
      action: 'SUBSCRIBER_UPDATE', requester: auth.auth.user, targetId: imsi,
      summary: `Update governed subscriber configuration for ${imsi}`,
      operation: { resourceType: 'subscriber', resourceId: imsi }, operationFingerprint: frozen.operationFingerprint,
      before: frozen.before, after: frozen.after, payload: frozen as unknown as Record<string, unknown>,
    });
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before subscriber update', approval }, { status: 202 });
  } catch (error) {
    if (error instanceof SubscriberGovernanceError) {
      const status = error.code === 'SUBSCRIBER_NOT_FOUND' ? 404 : error.code === 'SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED' ? 422 : 409;
      return NextResponse.json({ error: error.code }, { status });
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
    if (error instanceof Error && error.message === 'MSISDN_EXISTS') {
      return NextResponse.json({ error: 'MSISDN already exists' }, { status: 409 });
    }

    console.error('Error updating subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
