import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';
import { updateUser } from '@/server/repositories/userRepository';
import { authorizeUserOperation, recheckUserPolicy, userAudit, userOperationError } from '@/server/userManagement';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ username: string }> };

/** POST /api/users/{username}/password-reset -- set a new password for an account. */
export async function POST(request: Request, context: RouteContext) {
  const { username } = await context.params;
  const auth = await authorizeUserOperation(request, 'password.reset', username);
  if (!auth.ok) return auth.response;
  let committed = false;
  try {
    const rate = await enforceRateLimit(`users:reset-pw:${auth.auth.user}`, 10, 60);
    if (!rate.ok) return rate.response;
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.password !== 'string' || !isPasswordStrong(body.password, username)) {
      return NextResponse.json({ error: PASSWORD_POLICY_MESSAGE, code: 'INVALID_PASSWORD' }, { status: 400 });
    }
    if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
      return NextResponse.json({ error: 'PASSWORD_MISMATCH', code: 'PASSWORD_MISMATCH' }, { status: 400 });
    }
    let reason: string | undefined;
    if (body.reason !== undefined) {
      if (typeof body.reason !== 'string' || body.reason.length > 500) {
        return NextResponse.json({ error: 'INVALID_REASON', code: 'INVALID_REASON' }, { status: 400 });
      }
      reason = body.reason;
    }
    const passwordHash = await bcrypt.hash(body.password, 10);
    const updates = {
      passwordHash,
      security: { passwordChangedAt: new Date().toISOString(), failedLoginAttempts: 0 },
    };
    const result = await updateUser(username, updates, async (target) => {
      await recheckUserPolicy(auth.auth, target, ['password.reset']);
    });
    if (!result) return NextResponse.json({ error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }, { status: 404 });
    committed = true;
    await userAudit(request, 'password.reset', username, 'success', result.existing, result.next, undefined, reason);
    return NextResponse.json({ message: 'Password reset successful', sessionRevoked: true });
  } catch (error) { return userOperationError(error, request, 'password.reset', username, committed); }
}
