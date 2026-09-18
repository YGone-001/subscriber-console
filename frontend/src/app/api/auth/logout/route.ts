import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

export async function POST(request: Request) {
  const rateLimit = await enforceRateLimit(`auth:logout:${clientIp(request)}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  const response = NextResponse.json({ success: true });
  response.cookies.set('auth_token', '', { maxAge: 0, path: '/' });
  return response;
}
