import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { updateUser } from '@/server/repositories/userRepository';
import { authorizeUserOperation, recheckUserPolicy, userAudit, userOperationError } from '@/server/userManagement';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ username: string }> };

/** POST /api/users/{username}/disable -- soft-disable an account (status=disabled). */
export async function POST(request: Request, context: RouteContext) {
  const { username } = await context.params;
  const auth = await authorizeUserOperation(request, 'disable', username);
  if (!auth.ok) return auth.response;
  let committed = false;
  try {
    const rate = await enforceRateLimit(`users:disable:${auth.auth.user}`, 10, 60);
    if (!rate.ok) return rate.response;
    let reason: string | undefined;
    try {
      const body = await request.json() as Record<string, unknown>;
      if (body.reason !== undefined) {
        if (typeof body.reason !== 'string' || body.reason.length > 500) {
          return NextResponse.json({ error: 'INVALID_REASON', code: 'INVALID_REASON' }, { status: 400 });
        }
        reason = body.reason;
      }
    } catch {
      // body is optional for disable
    }
    const updates = {
      status: 'disabled' as const,
      locked: false,
      security: { failedLoginAttempts: 0 },
    };
    const result = await updateUser(username, updates, async (target) => {
      await recheckUserPolicy(auth.auth, target, ['disable']);
    });
    if (!result) return NextResponse.json({ error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }, { status: 404 });
    committed = true;
    await userAudit(request, 'disable', username, 'success', result.existing, result.next, undefined, reason);
    return NextResponse.json({ message: 'User disabled; account history was preserved', user: result.next, sessionRevoked: true });
  } catch (error) { return userOperationError(error, request, 'disable', username, committed); }
}
