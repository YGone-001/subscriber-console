import Redis from 'ioredis';

const globalForRedis = global as unknown as { redis: Redis };

export const redis =
  globalForRedis.redis ||
  new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    connectTimeout: 5000,
  });

redis.on('error', (err) => {
  console.error('[Redis Error]:', err);
});

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

/**
 * Helper to scan all keys matching a pattern without blocking Redis
 */
export async function scanAll(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, elements] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = nextCursor;
    keys.push(...elements);
  } while (cursor !== '0');
  return keys;
}
