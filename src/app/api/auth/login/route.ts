import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { getJwtSecretKey, isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';
import { getRateLimit } from '@/lib/rateLimit';
import { createUser, getUser } from '@/server/repositories/userRepository';
import type { UserDocument } from '@/server/repositories/userRepository';

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
    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    let storedUser: UserDocument | null = await getUser(username);
    if (!storedUser && username === 'admin') {
      const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
      if (initialPassword) {
        if (!isPasswordStrong(initialPassword)) {
          console.warn(`[SECURITY] INITIAL_ADMIN_PASSWORD is too weak (${PASSWORD_POLICY_MESSAGE}). Admin account NOT auto-provisioned.`);
        } else {
          const hash = await bcrypt.hash(initialPassword, 10);
          storedUser = await createUser({
            username: 'admin',
            passwordHash: hash,
            role: 'root',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: 'system',
          });
        }
      } else {
        console.warn('Admin account does not exist and INITIAL_ADMIN_PASSWORD is not set in .env');
      }
    }

    if (!storedUser || storedUser.status !== 'active') {
      return NextResponse.json({ error: 'Invalid credentials or account disabled' }, { status: 401 });
    }

    const isValid = await bcrypt.compare(password, storedUser.passwordHash);
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

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
      maxAge: 60 * 60 * 24,
    });

    response.headers.set('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    response.headers.set('X-RateLimit-Remaining', String(rateCheck.remaining));
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
