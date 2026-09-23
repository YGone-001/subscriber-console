import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return request.headers.get('x-real-ip')?.trim()
    || forwarded?.split(',')[0]?.trim()
    || 'unknown';
}

export async function POST(request: Request) {
  const rateLimit = await enforceRateLimit(`auth:logout:${clientIp(request)}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const isSecure = request.headers.get('x-forwarded-proto') === 'https' ||
                   request.url.startsWith('https:');

  const response = NextResponse.json({ success: true });
  response.headers.set('Cache-Control', 'no-store');
  response.cookies.set('auth_token', '', {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
