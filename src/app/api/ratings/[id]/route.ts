import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireCapability } from '@/lib/authz';
import { capabilityDecision } from '@/lib/permissions';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createApprovalRequest } from '@/server/repositories/approvalRepository';
import {
  deleteRating,
  getRating,
  updateRating,
} from '@/server/repositories/ratingRepository';

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
  const auth = requireCapability(request, 'rating_publish', { allowApproval: true });
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`ratings:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const body = await request.json();
    const planId = body?.planId || body?.plan_id || new URL(request.url).searchParams.get('planId') || undefined;
    if (capabilityDecision(auth.auth.role, 'rating_publish') === 'approval') {
      const approval = await createApprovalRequest({
        action: 'RATING_UPDATE',
        requester: auth.auth.user,
        targetId: `rating:${planId || 'plan_default_10gb'}:${id}`,
        summary: `Update rating group ${id} in ${planId || 'plan_default_10gb'}`,
        payload: {
          id,
          planId,
          changes: body,
        },
      });

      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json(
        { message: 'Approval required before rating update', approval },
        { status: 202 }
      );
    }

    await updateRating(id, body, planId);
    return NextResponse.json({ message: 'Rating updated successfully' });
  } catch (error) {
    console.error('Error updating rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const auth = requireCapability(request, 'rating_publish', { allowApproval: true });
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`ratings:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const planId = new URL(request.url).searchParams.get('planId') || undefined;
    if (capabilityDecision(auth.auth.role, 'rating_publish') === 'approval') {
      const approval = await createApprovalRequest({
        action: 'RATING_DELETE',
        requester: auth.auth.user,
        targetId: `rating:${planId || 'plan_default_10gb'}:${id}`,
        summary: `Delete rating group ${id} from ${planId || 'plan_default_10gb'}`,
        payload: { id, planId },
      });

      logAudit('UPDATE', `approval:${approval.id}`, null, approval, request);
      return NextResponse.json(
        { message: 'Approval required before rating deletion', approval },
        { status: 202 }
      );
    }

    const result = await deleteRating(id, planId);
    if (!result.deleted) {
      return NextResponse.json(
        {
          error: `Cannot delete: Rating group is currently used by ${result.references.count} subscribers`,
          examples: result.references.examples,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ message: 'Rating deleted successfully' });
  } catch (error) {
    console.error('Error deleting rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
