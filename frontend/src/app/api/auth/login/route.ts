import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { getJwtSecretKey } from '@/lib/security';
import { getRateLimit } from '@/lib/rateLimit';
import { getUser, recordFailedLogin, recordSuccessfulLogin } from '@/server/repositories/userRepository';
import type { UserDocument } from '@/server/repositories/userRepository';
import { normalizeGovernanceRole } from '@/lib/permissions';
import { scheduleAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';

const JWT_SECRET = getJwtSecretKey();
const RATE_LIMIT_IP_MAX = 5;
const RATE_LIMIT_IP_WINDOW = 60;
const RATE_LIMIT_USER_MAX = 10;
const RATE_LIMIT_USER_WINDOW = 300;

export async function POST(req: Request) {
  try {
    // 1. IP rate limiting (5 attempts per 60 seconds)
    const forwarded = req.headers.get('x-forwarded-for');
    const ip = req.headers.get('x-real-ip')?.trim()
      || forwarded?.split(',')[0]?.trim()
      || 'unknown';
    const rateCheck = await getRateLimit(`login:${ip}`, RATE_LIMIT_IP_MAX, RATE_LIMIT_IP_WINDOW);

    if (!rateCheck.allowed) {
      const res = NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateCheck.retryAfter),
            'X-RateLimit-Limit': String(RATE_LIMIT_IP_MAX),
            'X-RateLimit-Remaining': '0',
            'Cache-Control': 'no-store',
          },
        }
      );
      return res;
    }

    // 2. Request body validation
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: 'Username and password required' }, { status: 400 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    if (!body || typeof body !== 'object') {
      const res = NextResponse.json({ error: 'Username and password required' }, { status: 400 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    const { username, password } = body as Record<string, unknown>;
    if (
      typeof username !== 'string' ||
      username.length > 100 ||
      typeof password !== 'string' ||
      !username ||
      !password ||
      new TextEncoder().encode(password).length > 72
    ) {
      const res = NextResponse.json({ error: 'Username and password required' }, { status: 400 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    // 3. Account-scoped login rate limiting (10 attempts per 300 seconds)
    const normalizedUsername = username.trim().toLowerCase();
    const userRateCheck = await getRateLimit(
      `login-user:${normalizedUsername}`,
      RATE_LIMIT_USER_MAX,
      RATE_LIMIT_USER_WINDOW
    );

    if (!userRateCheck.allowed) {
      const res = NextResponse.json(
        { error: 'Too many login attempts. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(userRateCheck.retryAfter),
            'X-RateLimit-Limit': String(RATE_LIMIT_USER_MAX),
            'X-RateLimit-Remaining': '0',
            'Cache-Control': 'no-store',
          },
        }
      );
      return res;
    }

    // 4. Credential verification with constant-shape bcrypt work
    const storedUser: UserDocument | null = await getUser(username);
    const isValid = await bcrypt.compare(
      password,
      storedUser?.passwordHash ?? '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
    );

    // 5. Generic invalid credentials on any verification or state mismatch
    if (
      !storedUser ||
      !isValid ||
      storedUser.status !== 'active' ||
      storedUser.locked ||
      !normalizeGovernanceRole(storedUser.role)
    ) {
      if (storedUser && storedUser.status === 'active' && !storedUser.locked) {
        const lockResult = await recordFailedLogin(username);
        if (lockResult.locked) {
          scheduleAuditLog({
            actor: { type: 'system', username },
            module: 'security',
            action: 'auth.account.locked',
            result: 'success',
            resource: { type: 'user', id: username },
            metadata: { reason: 'excessive_failed_logins', attempts: lockResult.attempts },
            ...auditRequestContext(req),
          });
        }
      }

      scheduleAuditLog({
        actor: { type: 'user', username },
        module: 'security',
        action: 'auth.login',
        result: 'failed',
        resource: { type: 'user', id: username },
        ...auditRequestContext(req),
      });

      const res = NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    // 6. Record successful login with race-safe atomic state check
    const current = await recordSuccessfulLogin(storedUser, ip);
    if (!current) {
      const res = NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    // 7. Issue HS256 JWT auth_token cookie
    const role = current.role;
    const token = await new SignJWT({ username, role, sv: current.security?.sessionVersion ?? 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('24h')
      .sign(JWT_SECRET);

    const response = NextResponse.json({ success: true, username });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-RateLimit-Limit', String(RATE_LIMIT_IP_MAX));
    response.headers.set('X-RateLimit-Remaining', String(rateCheck.remaining));

    const isSecure = req.headers.get('x-forwarded-proto') === 'https' || req.url.startsWith('https:');

    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });

    scheduleAuditLog({
      actor: { type: 'user', username, role },
      module: 'security',
      action: 'auth.login',
      result: 'success',
      resource: { type: 'user', id: username },
      ...auditRequestContext(req),
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    const res = NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
}
