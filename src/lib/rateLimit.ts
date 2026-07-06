import { redis } from './redis';
import { NextResponse } from 'next/server';

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
  resetAt: number;
};

type RateLimitCheck =
  | { ok: true; rateLimit: RateLimitResult }
  | { ok: false; response: NextResponse; rateLimit: RateLimitResult };

/**
 * Basic fixed-window rate limiter using Redis.
 *
 * @param identifier Unique identifier for the client (e.g., IP, session token, or "global:action")
 * @param limit Maximum number of requests allowed in the window
 * @param windowSeconds Time window in seconds
 * @returns true if the request is allowed, false if rate limited
 */
export async function checkRateLimit(identifier: string, limit: number, windowSeconds: number): Promise<boolean> {
  const result = await getRateLimit(identifier, limit, windowSeconds);
  return result.allowed;
}

export async function getRateLimit(identifier: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(nowSeconds / windowSeconds);
    const key = `RATELIMIT:${identifier}:${currentWindow}`;
    const resetAt = (currentWindow + 1) * windowSeconds;

    // Atomically increment the counter for this window
    const current = await redis.incr(key);

    // Set expiration only on the first request in this window
    if (current === 1) {
      await redis.expire(key, windowSeconds * 2); // padding the expiration slightly
    }

    const remaining = Math.max(0, limit - current);
    return {
      allowed: current <= limit,
      limit,
      remaining,
      retryAfter: current > limit ? Math.max(1, resetAt - nowSeconds) : 0,
      resetAt,
    };
  } catch (error) {
    console.warn('Rate limiter Redis error, failing open:', error);
    return {
      allowed: true,
      limit,
      remaining: limit,
      retryAfter: 0,
      resetAt: Math.floor(Date.now() / 1000) + windowSeconds,
    }; // Fail open to not block legitimate traffic if Redis hiccups, though Redis is our main DB here
  }
}

export async function enforceRateLimit(
  identifier: string,
  limit: number,
  windowSeconds: number,
  message = 'Too many requests'
): Promise<RateLimitCheck> {
  const rateLimit = await getRateLimit(identifier, limit, windowSeconds);
  if (rateLimit.allowed) {
    return { ok: true, rateLimit };
  }

  const response = NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: rateLimitHeaders(rateLimit),
    }
  );

  return { ok: false, response, rateLimit };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };

  if (!result.allowed) {
    headers['Retry-After'] = String(result.retryAfter);
  }

  return headers;
}
