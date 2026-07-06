import { redis, scanAll } from '@/lib/redis';

export const SUBSCRIBER_INDEX_KEY = 'IDX:SUBSCRIBERS:IMSI';
const SUBSCRIBER_INDEX_READY_KEY = 'IDX:SUBSCRIBERS:READY';
const LEGACY_SUBSCRIBER_CACHE_KEY = 'CACHE:SUB_KEYS';
const IMSI_LENGTH = 15;

type RedisPipeline = ReturnType<typeof redis.pipeline>;

function imsiToScore(imsi: string): number {
  return Number(imsi);
}

function subscriberKeyToImsi(key: string): string {
  return key.replace('SUB_4G:', '');
}

function isValidImsi(imsi: string): boolean {
  return /^\d{15}$/.test(imsi);
}

function prefixBounds(prefix: string): [number, number] | null {
  if (!/^\d{1,15}$/.test(prefix)) return null;
  const min = prefix.padEnd(IMSI_LENGTH, '0');
  const max = prefix.padEnd(IMSI_LENGTH, '9');
  return [Number(min), Number(max)];
}

async function rebuildSubscriberIndex(): Promise<void> {
  const keys = await scanAll('SUB_4G:*');
  const imsis = keys.map(subscriberKeyToImsi).filter(isValidImsi);

  const pipeline = redis.pipeline();
  pipeline.del(SUBSCRIBER_INDEX_KEY);

  for (let i = 0; i < imsis.length; i += 500) {
    const chunk = imsis.slice(i, i + 500);
    if (chunk.length > 0) {
      pipeline.zadd(
        SUBSCRIBER_INDEX_KEY,
        ...chunk.flatMap((imsi) => [imsiToScore(imsi), imsi])
      );
    }
  }

  pipeline.set(SUBSCRIBER_INDEX_READY_KEY, '1');
  pipeline.del(LEGACY_SUBSCRIBER_CACHE_KEY);
  await pipeline.exec();
}

export async function ensureSubscriberIndex(): Promise<void> {
  const [ready, count] = await Promise.all([
    redis.get(SUBSCRIBER_INDEX_READY_KEY),
    redis.zcard(SUBSCRIBER_INDEX_KEY),
  ]);

  if (ready || count > 0) return;
  await rebuildSubscriberIndex();
}

export function addSubscriberToIndex(pipeline: RedisPipeline, imsi: string): void {
  if (!isValidImsi(imsi)) return;
  pipeline.zadd(SUBSCRIBER_INDEX_KEY, imsiToScore(imsi), imsi);
  pipeline.set(SUBSCRIBER_INDEX_READY_KEY, '1');
  pipeline.del(LEGACY_SUBSCRIBER_CACHE_KEY);
}

export function removeSubscriberFromIndex(pipeline: RedisPipeline, imsi: string): void {
  if (!isValidImsi(imsi)) return;
  pipeline.zrem(SUBSCRIBER_INDEX_KEY, imsi);
  pipeline.set(SUBSCRIBER_INDEX_READY_KEY, '1');
  pipeline.del(LEGACY_SUBSCRIBER_CACHE_KEY);
}

export async function listSubscriberImsis(page: number, limit: number, query = '') {
  await ensureSubscriberIndex();

  const safePage = Math.max(1, page);
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const start = (safePage - 1) * safeLimit;
  const end = start + safeLimit - 1;
  const trimmedQuery = query.trim();

  if (trimmedQuery) {
    const bounds = prefixBounds(trimmedQuery);
    if (!bounds) {
      return { imsis: [], total: 0, page: safePage, limit: safeLimit };
    }

    const [min, max] = bounds;
    const pipeline = redis.pipeline();
    pipeline.zcount(SUBSCRIBER_INDEX_KEY, min, max);
    pipeline.zrangebyscore(SUBSCRIBER_INDEX_KEY, min, max, 'LIMIT', start, safeLimit);
    const results = await pipeline.exec();

    return {
      imsis: (results?.[1]?.[1] as string[]) || [],
      total: Number(results?.[0]?.[1] || 0),
      page: safePage,
      limit: safeLimit,
    };
  }

  const pipeline = redis.pipeline();
  pipeline.zcard(SUBSCRIBER_INDEX_KEY);
  pipeline.zrange(SUBSCRIBER_INDEX_KEY, start, end);
  const results = await pipeline.exec();

  return {
    imsis: (results?.[1]?.[1] as string[]) || [],
    total: Number(results?.[0]?.[1] || 0),
    page: safePage,
    limit: safeLimit,
  };
}

export async function searchSubscriberImsisByPrefix(prefix: string, limit: number): Promise<string[]> {
  await ensureSubscriberIndex();

  const bounds = prefixBounds(prefix.trim());
  if (!bounds) return [];

  const safeLimit = Math.min(Math.max(1, limit), 50);
  const [min, max] = bounds;
  return redis.zrangebyscore(SUBSCRIBER_INDEX_KEY, min, max, 'LIMIT', 0, safeLimit);
}
