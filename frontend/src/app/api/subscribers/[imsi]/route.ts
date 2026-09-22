import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  findSubscriberLegacyState,
} from '@/server/repositories/subscriberRepository';
import { validateCurrentAccount, AccountSessionError } from '@/lib/accountSession';
import { validateImsi, validateSubscriberUpdatePayload } from '@/lib/subscriberValidation';
import {
  prepareFrozenSubscriberDelete,
  prepareFrozenSubscriberUpdate,
  executeFrozenSubscriberUpdate,
  executeFrozenSubscriberDelete,
  SubscriberGovernanceError,
} from '@/server/subscriberSingleGovernance';
import { evaluateSubscriberOperationForActor, SUBSCRIBER_OPERATIONS } from '@/server/subscriberGovernanceRegistry';

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
    // Fresh actor validation — fail closed
    const freshAccount = await validateCurrentAccount(auth.auth);

    const policy = evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.DELETE, freshAccount.normalizedRole);
    if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });

    const frozen = await prepareFrozenSubscriberDelete(imsi);

    // Direct execution
    await executeFrozenSubscriberDelete(frozen);
    try {
      await writeAuditLog({
        module: 'subscribers', action: 'DELETE', targetId: imsi,
        actor: { type: 'user', username: freshAccount.username, role: freshAccount.normalizedRole },
        before: frozen.before, after: { deleted: true, imsi },
        result: 'success',
        metadata: { governanceMode: 'DIRECT_GOVERNED', operation: 'SUBSCRIBER_DELETE', actorRole: freshAccount.normalizedRole },
      }, { failureMode: 'best-effort' });
    } catch (err) {
      console.warn('Audit log write failed for subscriber delete (non-gating):', err);
    }
    return NextResponse.json({ outcome: 'executed', message: 'Subscriber deleted successfully', imsi }, { status: 200 });
  } catch (error) {
    if (error instanceof SubscriberGovernanceError && error.code === 'SUBSCRIBER_NOT_FOUND') return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    if (error instanceof AccountSessionError) {
      const statusMap: Record<string, number> = { AUTH_INVALID_TOKEN: 401, ACCOUNT_NOT_FOUND: 401, ACCOUNT_DISABLED: 403, ACCOUNT_LOCKED: 403, SESSION_REVOKED: 403 };
      return NextResponse.json({ error: error.code }, { status: statusMap[error.code] || 500 });
    }
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

    // Fresh actor validation — fail closed
    const freshAccount = await validateCurrentAccount(auth.auth);

    const policy = evaluateSubscriberOperationForActor(SUBSCRIBER_OPERATIONS.UPDATE, freshAccount.normalizedRole);
    if (!policy.executable) return NextResponse.json({ error: 'OPERATION_NOT_EXECUTABLE' }, { status: 409 });

    const frozen = await prepareFrozenSubscriberUpdate(imsi, {
      sub4G: body.sub4G,
      auth4G: body.auth4G,
      ocsTraffic: body.ocsTraffic,
    });

    // Direct execution
    const result = await executeFrozenSubscriberUpdate(frozen);
    try {
      await writeAuditLog({
        module: 'subscribers', action: 'UPDATE', targetId: imsi,
        actor: { type: 'user', username: freshAccount.username, role: freshAccount.normalizedRole },
        before: frozen.before, after: result.after,
        result: 'success',
        metadata: { governanceMode: 'DIRECT_GOVERNED', operation: 'SUBSCRIBER_UPDATE', actorRole: freshAccount.normalizedRole },
      }, { failureMode: 'best-effort' });
    } catch (err) {
      console.warn('Audit log write failed for subscriber update (non-gating):', err);
    }
    return NextResponse.json({ outcome: 'executed', message: 'Subscriber updated successfully', imsi }, { status: 200 });
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
    if (error instanceof AccountSessionError) {
      const statusMap: Record<string, number> = { AUTH_INVALID_TOKEN: 401, ACCOUNT_NOT_FOUND: 401, ACCOUNT_DISABLED: 403, ACCOUNT_LOCKED: 403, SESSION_REVOKED: 403 };
      return NextResponse.json({ error: error.code }, { status: statusMap[error.code] || 500 });
    }

    console.error('Error updating subscriber:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
