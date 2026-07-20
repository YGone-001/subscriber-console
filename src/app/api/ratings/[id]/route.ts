import { NextResponse } from 'next/server';
import { requireAuth, requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
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
    const rating = await getRating(id);
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
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`ratings:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const body = await request.json();
    await updateRating(id, body);
    return NextResponse.json({ message: 'Rating updated successfully' });
  } catch (error) {
    console.error('Error updating rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const auth = requireCapability(request, 'rating_publish');
  if (!auth.ok) return auth.response;

  const rateLimit = await enforceRateLimit(`ratings:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!isValidRatingId(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });

  try {
    const result = await deleteRating(id);
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
