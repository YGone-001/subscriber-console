// Trigger reload
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { getJwtSecretKey, isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';

const JWT_SECRET = getJwtSecretKey();

// ---------------------------------------------------------------------------
// Rate-limit: sliding window – max 5 login attempts per IP per 60 seconds
// ---------------------------------------------------------------------------
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60; // seconds

async function isRateLimited(ip: string): Promise<{ limited: boolean; remaining: number; retryAfter: number }> {
  const key = `RATE:LOGIN:${ip}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW * 1000;

  const pipeline = redis.pipeline();
  // Remove expired entries
  pipeline.zremrangebyscore(key, 0, windowStart);
  // Add the current request
  pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);
  // Count requests in window
  pipeline.zcard(key);
  // Set TTL so the key self-cleans
  pipeline.expire(key, RATE_LIMIT_WINDOW);

  const results = await pipeline.exec();
  const count = (results?.[2]?.[1] as number) || 0;

  if (count > RATE_LIMIT_MAX) {
    // Find the oldest entry in the window to calculate retry-after
    const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const oldestTs = oldest.length >= 2 ? Number(oldest[1]) : now;
    const retryAfter = Math.ceil((oldestTs + RATE_LIMIT_WINDOW * 1000 - now) / 1000);
    return { limited: true, remaining: 0, retryAfter: Math.max(1, retryAfter) };
  }

  return { limited: false, remaining: RATE_LIMIT_MAX - count, retryAfter: 0 };
}

export async function POST(req: Request) {
  try {
    // Extract client IP for rate limiting
    const forwarded = req.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';

    // Check rate limit
    const rateCheck = await isRateLimited(ip);
    if (rateCheck.limited) {
      return NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateCheck.retryAfter),
            'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    const { username, password } = await req.json();

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const storedUserStr = await redis.get(`SYS_USER:${username}`);
    let storedUser: any = null;

    if (!storedUserStr && username === 'admin') {
      const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
      if (initialPassword) {
        if (!isPasswordStrong(initialPassword)) {
          console.warn(`[SECURITY] INITIAL_ADMIN_PASSWORD is too weak (${PASSWORD_POLICY_MESSAGE}). Admin account NOT auto-provisioned.`);
        } else {
          const hash = await bcrypt.hash(initialPassword, 10);
          storedUser = {
            username: 'admin',
            passwordHash: hash,
            role: 'root',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: 'system'
          };
          await redis.set('SYS_USER:admin', JSON.stringify(storedUser));
        }
      } else {
        console.warn('Admin account does not exist and INITIAL_ADMIN_PASSWORD is not set in .env');
      }
    } else if (storedUserStr) {
      try {
        storedUser = JSON.parse(storedUserStr as string);
      } catch (e) {
        console.error('Failed to parse SYS_USER', e);
      }
    }

    if (!storedUser || storedUser.status !== 'active') {
      return NextResponse.json({ error: 'Invalid credentials or account disabled' }, { status: 401 });
    }

    const isValid = await bcrypt.compare(password, storedUser.passwordHash);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Create JWT
    const role = storedUser.role;

    const token = await new SignJWT({ username, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('24h')
      .sign(JWT_SECRET);

    const response = NextResponse.json({ success: true, username });
    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 // 1 day
    });

    // Add rate limit headers to successful responses too
    response.headers.set('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    response.headers.set('X-RateLimit-Remaining', String(rateCheck.remaining));

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
