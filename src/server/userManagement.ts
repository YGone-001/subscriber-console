import { NextResponse } from 'next/server';
import { writeAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import { requirePermission, type AuthContext } from '@/lib/authz';
import { AccountSessionError, validateCurrentAccount } from '@/lib/accountSession';
import { checkUserManagementPolicy, USER_OPERATION_PERMISSIONS, UserManagementError, type UserOperation } from '@/lib/userManagementPolicy';
import type { UserDocument } from '@/server/repositories/userRepository';

export async function authorizeUserOperation(request: Request, operation: UserOperation, username?: string) {
  const auth = requirePermission(request, USER_OPERATION_PERMISSIONS[operation]);
  if (!auth.ok && auth.response.status === 403) await userAudit(request, operation, username || 'directory', 'denied', undefined, undefined, 'PERMISSION_DENIED');
  return auth;
}

export async function recheckUserPolicy(auth: AuthContext, target: UserDocument | null, operations: UserOperation[], nextRole?: unknown) {
  try {
    const actor = await validateCurrentAccount({ username: auth.user, role: auth.role, sv: auth.sessionVersion });
    for (const operation of operations) checkUserManagementPolicy(actor, target, operation, nextRole);
  } catch (error) {
    if (error instanceof AccountSessionError) throw new UserManagementError(error.code, 401);
    throw error;
  }
}

function snapshot(user?: UserDocument) {
  return user ? { username: user.username, displayName: user.displayName, email: user.email, role: user.role, status: user.status } : undefined;
}

/** Never pass a password/hash to audit, even before sanitization. */
export async function userAudit(request: Request, operation: UserOperation, username: string, result: 'success' | 'failed' | 'denied', before?: UserDocument, after?: UserDocument, code?: string, bodyReason?: string) {
  const context = auditRequestContext(request);
  return writeAuditLog({
    actor: { type: 'user', username: request.headers.get('x-user') || 'unknown', role: request.headers.get('x-user-role') || undefined },
    module: 'users', action: `user.${operation}`, result, resource: { type: 'user', id: username },
    ...(operation === 'password.reset' ? { metadata: { passwordReset: true, ...(code ? { code } : {}) } } : {
      before: operation === 'role.change' && before ? { role: before.role } : snapshot(before),
      after: operation === 'role.change' && after ? { role: after.role } : snapshot(after), metadata: code ? { code } : undefined,
    }),
    ...context,
    reason: bodyReason?.trim().slice(0, 1000) || context.reason,
  }, { failureMode: result === 'success' ? 'strict' : 'best-effort' });
}

export async function userOperationError(error: unknown, request: Request, operation: UserOperation, username: string, committed = false) {
  if (committed) return NextResponse.json({ error: 'Account changed, but audit persistence could not be confirmed. Do not repeat blindly.', code: 'AUDIT_UNAVAILABLE', committed: true }, { status: 503 });
  const known = error instanceof UserManagementError;
  const code = known ? error.code : error instanceof SyntaxError ? 'INVALID_BODY' : 'USER_OPERATION_FAILED';
  const status = known ? error.status : error instanceof SyntaxError ? 400 : 503;
  await userAudit(request, operation, username, status === 403 ? 'denied' : 'failed', undefined, undefined, code);
  return NextResponse.json({ error: code, code }, { status });
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UserManagementError('INVALID_BODY', 400);
  return body as Record<string, unknown>;
}

export function profileFields(body: Record<string, unknown>, requiredName = false) {
  const fields: { displayName?: string; email?: string } = {};
  if (requiredName || Object.hasOwn(body, 'displayName')) {
    if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.trim().length > 100) throw new UserManagementError('INVALID_DISPLAY_NAME', 400);
    fields.displayName = body.displayName.trim();
  }
  if (Object.hasOwn(body, 'email')) {
    if (typeof body.email !== 'string' || body.email.length > 254 || (body.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()))) throw new UserManagementError('INVALID_EMAIL', 400);
    fields.email = body.email.trim();
  }
  return fields;
}
