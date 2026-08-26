import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getSafeUser } from '@/server/repositories/userRepository';
import { normalizeGovernanceRole, permissionsFor } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireAuth(request);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`auth:me:${auth.auth.user}`, 120, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const user = await getSafeUser(auth.auth.user);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized', code: 'ACCOUNT_NOT_FOUND' }, { status: 401 });
    }

    return NextResponse.json({
      username: user.username,
      role: user.role,
      databaseRole: user.role,
      normalizedRole: normalizeGovernanceRole(user.role),
      permissions: permissionsFor(user),
      createdAt: user.createdAt,
      status: user.status,
    }, { status: 200 });
  } catch (error) {
    console.error('Error fetching current user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
