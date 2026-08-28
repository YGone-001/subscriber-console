import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import {
  getRating,
} from '@/server/repositories/ratingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

function isValidRatingId(id: string): boolean {
  return /^\d+$/.test(id);
}

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`ratings:detail:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const planId = new URL(request.url).searchParams.get('planId') || undefined;
    const rating = await getRating(id, planId);
    if (!rating) {
      return NextResponse.json({ error: 'Rating not found' }, { status: 404 });
    }

    return NextResponse.json({ rating });
  } catch (error) {
    console.error('Error fetching rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.RATING_UPDATE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_RATING_UPDATE_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_RATING_UPDATE_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`ratings:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const body = await request.json();
    const planId = body?.planId || body?.plan_id || new URL(request.url).searchParams.get('planId') || undefined;
    const before = await getRating(id, planId);
    if (!before) return NextResponse.json({ error: 'Rating not found' }, { status: 404 });
    const approval = await createApprovalRequest({ action: 'RATING_UPDATE', requester: auth.auth.user, targetId: `rating:${planId || 'plan_default_10gb'}:${id}`, summary: `Update rating group ${id} in ${planId || 'plan_default_10gb'}`, operation: { resourceType: 'ocs_rating', resourceId: `${planId || 'plan_default_10gb'}:${id}` }, before, payload: { id, planId, changes: body } });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before rating update', approval }, { status: 202 });
  } catch (error) {
    console.error('Error updating rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const definition = evaluateOcsOperation(OCS_OPERATIONS.RATING_DELETE);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_RATING_DELETE_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_RATING_DELETE_NOT_SUPPORTED' }, { status: 409 });

  const rateLimit = await enforceRateLimit(`ratings:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const planId = new URL(request.url).searchParams.get('planId') || undefined;
    const before = await getRating(id, planId);
    if (!before) return NextResponse.json({ error: 'Rating not found' }, { status: 404 });
    const approval = await createApprovalRequest({ action: 'RATING_DELETE', requester: auth.auth.user, targetId: `rating:${planId || 'plan_default_10gb'}:${id}`, summary: `Delete rating group ${id} from ${planId || 'plan_default_10gb'}`, operation: { resourceType: 'ocs_rating', resourceId: `${planId || 'plan_default_10gb'}:${id}` }, before, payload: { id, planId } });
    logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
    return NextResponse.json({ outcome: 'approval_required', message: 'Approval required before rating deletion', approval }, { status: 202 });
  } catch (error) {
    console.error('Error deleting rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
