import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { enforceRateLimit } from '@/lib/rateLimit';
import { searchSubscriberImsisByPrefix } from '@/lib/subscriberIndex';
import { requireAuth } from '@/lib/authz';

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

function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?\[\]]/g, '\\$&');
}

async function scanLimited(pattern: string, limit: number, count = 200): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, elements] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = nextCursor;
    keys.push(...elements);
  } while (cursor !== '0' && keys.length < limit);

  return keys.slice(0, limit);
}

async function searchSubscribers(query: string, limit: number): Promise<SearchResult[]> {
  if (!/^\d+$/.test(query)) return [];

  const imsis = await searchSubscriberImsisByPrefix(query, limit);
  return imsis.map((imsi) => {
    return {
      id: `imsi-${imsi}`,
      label: imsi,
      desc: 'Open subscriber',
      type: 'imsi' as const,
      path: '/subscribers',
    };
  });
}

async function searchProfiles(query: string, limit: number): Promise<SearchResult[]> {
  const keys = await scanLimited(`PROFILE:*${escapeRedisGlob(query)}*`, limit);
  if (keys.length === 0) return [];

  const pipeline = redis.pipeline();
  keys.forEach((key) => pipeline.get(key));
  const values = await pipeline.exec();

  return keys.map((key, index) => {
    const name = key.replace('PROFILE:', '');
    let title = name;
    const raw = values?.[index]?.[1];

    if (typeof raw === 'string') {
      try {
        const data = JSON.parse(raw) as { title?: unknown };
        if (typeof data.title === 'string' && data.title.trim()) title = data.title;
      } catch {
        title = name;
      }
    }

    return {
      id: `profile-${name}`,
      label: name,
      desc: title === name ? 'Open profile template' : title,
      type: 'profile' as const,
      path: '/profile',
    };
  });
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
