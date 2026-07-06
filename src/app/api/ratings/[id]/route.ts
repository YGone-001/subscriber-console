import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAuth, requireRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * GET /api/ratings/[id]
 * 获取单个费率模板的完整数据
 * Redis 键: OCS:RATES:RATES_[id]
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`ratings:detail:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Invalid rating ID format' }, { status: 400 });
  try {
    const raw = await redis.get(`OCS:RATES:RATES_${id}`);
    if (!raw) {
      return NextResponse.json({ error: 'Rating not found' }, { status: 404 });
    }
    return NextResponse.json({ rating: JSON.parse(raw) });
  } catch (error) {
    console.error('Error fetching rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * PUT /api/ratings/[id]
 * 更新指定费率模板 (不允许修改 rating_group_id)
 * 可更新字段: currency, rates, rates_type
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = requireRole(request, 'root');
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`ratings:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();
    const existingRaw = await redis.get(`OCS:RATES:RATES_${id}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};

    // 合并更新, 严格保持 OCS:RATES 四字段结构
    const updated = {
      currency: body.currency || existing.currency || 'USD',
      rates: String(body.rates !== undefined ? body.rates : existing.rates || '0'),
      rates_type: Number(body.rates_type !== undefined ? body.rates_type : existing.rates_type || 1),
      rating_group_id: Number(id)
    };

    await redis.set(`OCS:RATES:RATES_${id}`, JSON.stringify(updated));
    return NextResponse.json({ message: 'Rating updated successfully' });
  } catch (error) {
    console.error('Error updating rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

type RatingReferenceScan = {
  count: number;
  examples: string[];
};

function ratesMapUsesRating(raw: string, id: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { rates_map?: unknown };
    if (!parsed.rates_map || typeof parsed.rates_map !== 'object') {
      return false;
    }

    return Object.values(parsed.rates_map as Record<string, unknown>).some((value) => String(value) === id);
  } catch {
    return false;
  }
}

function imsiFromImsiSetKey(key: string): string {
  return key.substring('OCS:IMSI:IMSI_SET_'.length);
}

async function scanRatingReferences(id: string): Promise<RatingReferenceScan> {
  let cursor = '0';
  let count = 0;
  const examples: string[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'OCS:IMSI:IMSI_SET_*', 'COUNT', 500);
    cursor = nextCursor;

    if (keys.length === 0) continue;

    const pipeline = redis.pipeline();
    keys.forEach((key) => pipeline.get(key));
    const results = await pipeline.exec();

    if (!results) continue;

    for (let i = 0; i < results.length; i++) {
      const [err, value] = results[i];
      if (err || typeof value !== 'string') continue;

      if (ratesMapUsesRating(value, id)) {
        count++;
        if (examples.length < 5) {
          examples.push(imsiFromImsiSetKey(keys[i]));
        }
      }
    }
  } while (cursor !== '0');

  return { count, examples };
}

/**
 * DELETE /api/ratings/[id]
 * 删除指定费率模板
 * 注意: 删除前应确认无关联的 IMSI_SET 引用, 此处仅做物理删除
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = requireRole(request, 'root');
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`ratings:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const refCountRaw = await redis.hget('STATS:RATES_COUNT', id);
    if (Number(refCountRaw) > 0) {
      return NextResponse.json({ error: `Cannot delete: Rating group is currently used by ${refCountRaw} subscribers` }, { status: 409 });
    }

    const liveReferences = await scanRatingReferences(id);
    if (liveReferences.count > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete: Rating group is currently used by ${liveReferences.count} subscribers`,
          examples: liveReferences.examples,
        },
        { status: 409 }
      );
    }

    await redis.del(`OCS:RATES:RATES_${id}`);
    return NextResponse.json({ message: 'Rating deleted successfully' });
  } catch (error) {
    console.error('Error deleting rating:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
