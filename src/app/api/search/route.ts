import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { requireAuth } from '@/lib/authz';
import { listSubscriberImsis } from '@/server/repositories/subscriberRepository';
import { listProfiles } from '@/server/repositories/profileRepository';

export const dynamic = 'force-dynamic';

type SearchResult = {
  id: string;
  label: string;
  desc: string;
  type: 'imsi' | 'profile';
  path: string;
};

function clampLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '', 10);
  if (Number.isNaN(parsed)) return 8;
  return Math.min(Math.max(parsed, 1), 12);
}

async function searchSubscribers(query: string, limit: number): Promise<SearchResult[]> {
  if (!/^\d+$/.test(query)) return [];

  const { subscribers } = await listSubscriberImsis(1, limit, query);
  return subscribers.map((imsi) => ({
    id: `imsi-${imsi}`,
    label: imsi,
    desc: 'Open subscriber',
    type: 'imsi',
    path: '/subscribers',
  }));
}

async function searchProfiles(query: string, limit: number): Promise<SearchResult[]> {
  if (limit <= 0) return [];
  const needle = query.toLowerCase();
  const profiles = await listProfiles();

  return profiles
    .filter((profile) => {
      const name = String(profile.name || '').toLowerCase();
      const title = String(profile.title || '').toLowerCase();
      return name.includes(needle) || title.includes(needle);
    })
    .slice(0, limit)
    .map((profile) => ({
      id: `profile-${profile.name}`,
      label: profile.name,
      desc: profile.title === profile.name ? 'Open profile template' : profile.title,
      type: 'profile',
      path: '/profile',
    }));
}

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;

    const rateLimit = await enforceRateLimit(`search:${auth.auth.user}`, 60, 60, 'Too many search requests');
    if (!rateLimit.ok) return rateLimit.response;

    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();
    const limit = clampLimit(searchParams.get('limit'));

    if (query.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const subscriberLimit = Math.ceil(limit / 2);
    const profileLimit = limit - subscriberLimit;
    const [subscribers, profiles] = await Promise.all([
      searchSubscribers(query, subscriberLimit),
      searchProfiles(query, profileLimit),
    ]);

    return NextResponse.json({ results: [...subscribers, ...profiles].slice(0, limit) });
  } catch (error) {
    console.error('Error searching:', error);
    return NextResponse.json({ error: 'Failed to search' }, { status: 500 });
  }
}
