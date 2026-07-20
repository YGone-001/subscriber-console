import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth, requireCapability } from '@/lib/authz';
import {
  createRating,
  listRatings,
} from '@/server/repositories/ratingRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ratings:list:${auth.auth.user}`, 90, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const ratings = await listRatings();
    return NextResponse.json({ ratings });
  } catch (error) {
    console.error('Error fetching ratings:', error);
    return NextResponse.json({ error: 'Failed to fetch ratings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'rating_publish');
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`ratings:create:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const data = await request.json();
    const { rating_group_id } = data;

    if (rating_group_id === undefined || rating_group_id === null || rating_group_id === '') {
      return NextResponse.json({ error: 'rating_group_id is required' }, { status: 400 });
    }
    if (!/^\d+$/.test(String(rating_group_id))) {
      return NextResponse.json({ error: 'Invalid rating_group_id format' }, { status: 400 });
    }

    const rating = await createRating(data);

    return NextResponse.json({ message: 'Rating created successfully', rating_group_id: rating.rating_group_id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'RATING_EXISTS') {
      return NextResponse.json({ error: 'Rating Group ID already exists' }, { status: 409 });
    }

    console.error('Error creating rating:', error);
    return NextResponse.json({ error: 'Failed to create rating' }, { status: 500 });
  }
}
