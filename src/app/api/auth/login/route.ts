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
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60;

export async function POST(req: Request) {
  try {
    const forwarded = req.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
    const rateCheck = await getRateLimit(`login:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW);

    if (!rateCheck.allowed) {
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
    if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || !username || !password || new TextEncoder().encode(password).length > 72) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const storedUser: UserDocument | null = await getUser(username);
    const isValid = await bcrypt.compare(password, storedUser?.passwordHash ?? '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!storedUser || !isValid || storedUser.status !== 'active' || storedUser.locked || !normalizeGovernanceRole(storedUser.role)) {
      if (storedUser) await recordFailedLogin(username);
      scheduleAuditLog({ actor: { type: 'user', username }, module: 'security', action: 'auth.login', result: 'failed', resource: { type: 'user', id: username }, ...auditRequestContext(req) });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const current = await recordSuccessfulLogin(storedUser, ip);
    if (!current) return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    const role = current.role;
    const token = await new SignJWT({ username, role, sv: current.security?.sessionVersion ?? 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('24h')
      .sign(JWT_SECRET);

    const response = NextResponse.json({ success: true, username });
    // Only set Secure flag when actually serving over HTTPS (proxied or direct)
    const isSecure = req.headers.get('x-forwarded-proto') === 'https' ||
                     req.url.startsWith('https');

    response.cookies.set('auth_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });

    response.headers.set('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    response.headers.set('X-RateLimit-Remaining', String(rateCheck.remaining));
    scheduleAuditLog({ actor: { type: 'user', username, role }, module: 'security', action: 'auth.login', result: 'success', resource: { type: 'user', id: username }, ...auditRequestContext(req) });
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
