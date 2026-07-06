// Trigger reload
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`auth:me:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const storedUserStr = await redis.get(`SYS_USER:${auth.auth.user}`);

    if (!storedUserStr) {
      return NextResponse.json({ username: auth.auth.user, role: auth.auth.role }, { status: 200 });
    }

    const user = JSON.parse(storedUserStr as string);
    // Don't leak password hash
    return NextResponse.json({
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      status: user.status
    }, { status: 200 });

  } catch (error) {
    console.error('Error fetching current user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
