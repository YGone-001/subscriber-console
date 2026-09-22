import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requirePermission } from '@/lib/authz';
import {
  createRating,
  getRating,
  listRatings,
} from '@/server/repositories/ratingRepository';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ratings:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const planId = new URL(request.url).searchParams.get('planId') || undefined;
    const ratings = await listRatings(planId);
    return NextResponse.json({ ratings });
  } catch (error) {
    console.error('Error fetching ratings:', error);
    return NextResponse.json({ error: 'Failed to fetch ratings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const definition = evaluateOcsOperation(OCS_OPERATIONS.RATING_CREATE);
    const auth = requirePermission(request, definition.permission);
    if (!auth.ok) return auth.response;
    if (!definition.executable) return NextResponse.json({ error: definition.disabledCode || 'OCS_RATING_CREATE_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_RATING_CREATE_NOT_SUPPORTED' }, { status: 409 });

    const rateLimit = await enforceRateLimit(`ratings:create:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const { rating_group_id } = data;
    const planId = data?.planId || data?.plan_id;

    if (rating_group_id === undefined || rating_group_id === null || rating_group_id === '') {
      return NextResponse.json({ error: 'rating_group_id is required' }, { status: 400 });
    }
    if (!/^\d+$/.test(String(rating_group_id))) {
      return NextResponse.json({ error: 'Invalid rating_group_id format' }, { status: 400 });
    }

    const existing = await getRating(String(rating_group_id), planId);
    if (existing) return NextResponse.json({ error: 'Rating Group ID already exists' }, { status: 409 });
    const result = await createRating(data, planId);
    try {
      logAudit('CREATE', `rating:${result.rating_group_id}`, null, result, request);
    } catch (auditErr) {
      console.warn('Non-gating audit log failed:', auditErr);
    }
    return NextResponse.json({ success: true, rating: result }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATING_EXISTS') {
      return NextResponse.json({ error: 'Rating Group ID already exists' }, { status: 409 });
    }

    console.error('Error creating rating:', error);
    return NextResponse.json({ error: 'Failed to create rating' }, { status: 500 });
  }
}
