import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const MAX_ACK_IDS = 200;

/**
 * POST /api/alerts/acknowledge
 *
 * Supports both single and batch alert acknowledgment.
 *
 * Body: { id: string }            — acknowledge a single alert
 * Body: { ids: string[] }         — acknowledge multiple alerts at once
 *
 * Uses atomic read-compare-write via a Lua script to avoid the
 * race condition where LSET-by-index could target the wrong alert
 * if the list is modified between LRANGE and LSET.
 */

// Lua script: atomically find alert by ID and set is_acknowledged = true.
// Returns the count of acknowledged alerts.
const ACK_LUA = `
local key = KEYS[1]
local ids = {}
for i = 1, #ARGV do
  ids[ARGV[i]] = true
end

local len = redis.call('LLEN', key)
local acked = 0

for i = 0, len - 1 do
  local raw = redis.call('LINDEX', key, i)
  if raw then
    local ok, obj = pcall(cjson.decode, raw)
    if ok and obj and obj.id and ids[obj.id] and not obj.is_acknowledged then
      obj.is_acknowledged = true
      redis.call('LSET', key, i, cjson.encode(obj))
      acked = acked + 1
    end
  end
end

return acked
`;

export async function POST(request: Request) {
  const auth = requireAnyRole(request, ['root', 'operator']);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`alerts:acknowledge:${auth.auth.user}`, 60, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json() as { id?: unknown; ids?: unknown };
    const { id, ids } = body;

    const rawIds = Array.isArray(ids) ? ids : [id];
    const alertIds = Array.from(
      new Set(
        rawIds
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      )
    );

    if (alertIds.length === 0) {
      return NextResponse.json({ error: 'Alert ID(s) required' }, { status: 400 });
    }

    if (alertIds.length > MAX_ACK_IDS) {
      return NextResponse.json({ error: `At most ${MAX_ACK_IDS} alerts can be acknowledged at once` }, { status: 400 });
    }

    const ackedCount = await redis.eval(
      ACK_LUA,
      1,
      'LOG:ALERTS:LOCAL',
      ...alertIds
    );

    const acknowledged = Number(ackedCount);

    return NextResponse.json({
      success: true,
      acknowledged,
      requested: alertIds.length,
      skipped: alertIds.length - acknowledged,
    });
  } catch (error) {
    console.error('Alert acknowledge error:', error);
    return NextResponse.json({ error: 'Failed to acknowledge alert' }, { status: 500 });
  }
}
