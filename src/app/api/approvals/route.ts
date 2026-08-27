import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { validateCurrentAccount } from '@/lib/accountSession';
import { requirePermission } from '@/lib/authz';
import { isRiskLevel } from '@/lib/governance/risk';
import { enforceRateLimit } from '@/lib/rateLimit';
import { hasPermission } from '@/lib/permissions';
import { approvalActionEligibility } from '@/server/approvalWorkflow';
import { isSupportedApprovalAction } from '@/server/approvalRiskPolicy';
import { getUser } from '@/server/repositories/userRepository';
import { createApprovalRequest, getPendingAccessRequest, isApprovalStatus, listApprovals } from '@/server/repositories/approvalRepository';

export const dynamic = 'force-dynamic';

function boundedInt(value: string | null, fallback: number, max: number) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) ? Math.min(Math.max(number, 1), max) : fallback;
}

function dateParam(value: string | null, endOfDay = false): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : value;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

export async function GET(request: Request) {
  const auth = requirePermission(request, 'approvals.read');
  if (!auth.ok) return auth.response;
  const rate = await enforceRateLimit(`approvals:list:${auth.auth.user}`, 80, 60);
  if (!rate.ok) return rate.response;
  const params = new URL(request.url).searchParams;
  const rawStatus = params.get('status');
  const rawRisk = params.get('risk');
  const rawAction = params.get('action');
  if (rawStatus && rawStatus !== 'all' && !isApprovalStatus(rawStatus)) return Response.json({ error: 'INVALID_STATUS', code: 'INVALID_STATUS' }, { status: 400 });
  if (rawRisk && !isRiskLevel(rawRisk)) return Response.json({ error: 'INVALID_RISK', code: 'INVALID_RISK' }, { status: 400 });
  if (rawAction && !isSupportedApprovalAction(rawAction)) return Response.json({ error: 'INVALID_ACTION', code: 'INVALID_ACTION' }, { status: 400 });
  const status = rawStatus && rawStatus !== 'all' && isApprovalStatus(rawStatus) ? rawStatus : 'all';
  const risk = isRiskLevel(rawRisk) ? rawRisk : undefined;
  const action = isSupportedApprovalAction(rawAction) ? rawAction : undefined;
  const fromTime = dateParam(params.get('from'));
  const toTime = dateParam(params.get('to'), true);
  if ((params.get('from') && fromTime === null) || (params.get('to') && toTime === null)) return Response.json({ error: 'INVALID_DATE_RANGE', code: 'INVALID_DATE_RANGE' }, { status: 400 });
  try {
    const result = await listApprovals({
      page: boundedInt(params.get('page'), 1, 100000),
      pageSize: boundedInt(params.get('pageSize') || params.get('limit'), 20, 100),
      q: params.get('q')?.trim().slice(0, 200) || undefined,
      status,
      risk,
      action,
      resourceType: params.get('resourceType')?.trim().slice(0, 100) || undefined,
      resourceId: params.get('resourceId')?.trim().slice(0, 200) || undefined,
      requester: params.get('requester')?.trim().slice(0, 100) || undefined,
      reviewer: params.get('reviewer')?.trim().slice(0, 100) || undefined,
      fromTime, toTime,
      actor: { user: auth.auth.user, canApprove: hasPermission({ role: auth.auth.role }, 'approvals.approve') },
    });
    return Response.json({ ...result, approvals: result.approvals.map((approval) => ({ ...approval, actions: approvalActionEligibility(approval, auth.auth) })) });
  } catch (error) {
    console.error('Error fetching approvals:', error);
    return Response.json({ error: 'APPROVAL_QUERY_FAILED', code: 'APPROVAL_QUERY_FAILED' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const auth = requirePermission(request, 'approvals.create');
  if (!auth.ok) return auth.response;
  const rate = await enforceRateLimit(`approvals:access-request:${auth.auth.user}`, 6, 60);
  if (!rate.ok) return rate.response;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';
  if (reason.length < 8) return Response.json({ error: 'ACCESS_REASON_REQUIRED', code: 'ACCESS_REASON_REQUIRED' }, { status: 400 });
  const user = await getUser(auth.auth.user);
  if (!user || user.status !== 'active') return Response.json({ error: 'ACCOUNT_NOT_ELIGIBLE', code: 'ACCOUNT_NOT_ELIGIBLE' }, { status: 403 });
  if (user.role !== 'viewer') return Response.json({ error: 'ACCESS_ALREADY_GRANTED', code: 'ACCESS_ALREADY_GRANTED' }, { status: 409 });
  const existing = await getPendingAccessRequest(user.username);
  if (existing) return Response.json({ error: 'ACCESS_REQUEST_PENDING', code: 'ACCESS_REQUEST_PENDING', approval: existing }, { status: 409 });
  try {
    const account = await validateCurrentAccount({ username: auth.auth.user, role: auth.auth.role, sv: auth.auth.sessionVersion });
    const actor = { type: 'user' as const, userId: account.userId, username: account.username, role: account.role };
    const approval = await createApprovalRequest({
      action: 'ACCESS_REQUEST', requester: user.username, requesterContext: actor,
      targetId: user.username, summary: 'Request viewer to operator access', title: 'Request viewer to operator access',
      operation: { resourceType: 'user', resourceId: user.username }, reason,
      before: { role: 'viewer', status: user.status }, after: { role: 'operator', status: user.status },
      payload: { currentRole: 'viewer', requestedRole: 'operator', reason },
    });
    const context = auditRequestContext(request);
    try {
      await writeAuditLog({ actor, module: 'approvals', action: 'approval.create',
        resource: { type: 'approval', id: approval.id, name: approval.changeId || approval.id }, targetId: `approval:${approval.id}`,
        approvalId: approval.id, riskLevel: approval.riskLevel, result: 'success', after: approval,
        ...context, reason,
      }, { failureMode: 'strict' });
    } catch {
      console.error('APPROVAL_AUDIT_PERSISTENCE_ALERT', { approvalId: approval.id, action: 'approval.create' });
      return Response.json({ error: 'AUDIT_UNAVAILABLE', code: 'AUDIT_UNAVAILABLE', committed: true, approval }, { status: 503 });
    }
    return Response.json({ approval: { ...approval, actions: approvalActionEligibility(approval, auth.auth) } }, { status: 201 });
  } catch (error) {
    console.error('Failed to create access request:', error);
    return Response.json({ error: 'APPROVAL_CREATE_FAILED', code: 'APPROVAL_CREATE_FAILED' }, { status: 503 });
  }
}
