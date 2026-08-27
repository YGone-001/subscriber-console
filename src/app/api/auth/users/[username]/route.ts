import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';
import { normalizeGovernanceRole, permissionsFor } from '@/lib/permissions';
import { assignableRoles, userManagementActions, UserManagementError, type UserOperation } from '@/lib/userManagementPolicy';
import { getSafeUser, safeUser, updateUser, type UserDocument } from '@/server/repositories/userRepository';
import { listAuditLogsForUser } from '@/server/repositories/auditRepository';
import { authorizeUserOperation, profileFields, recheckUserPolicy, requireObject, userAudit, userOperationError } from '@/server/userManagement';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ username: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const auth = requirePermission(request, 'users.read');
  if (!auth.ok) return auth.response;
  try {
    const { username } = await params;
    const user = await getSafeUser(username);
    if (!user) return NextResponse.json({ error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' }, { status: 404 });
    const actor = { username: auth.auth.user, role: auth.auth.role };
    return NextResponse.json({ user, normalizedRole: normalizeGovernanceRole(user.role), permissions: permissionsFor({ role: user.role }),
      actions: userManagementActions(actor, user), assignableRoles: assignableRoles(actor),
      activity: await listAuditLogsForUser(username) });
  } catch { return NextResponse.json({ error: 'USER_QUERY_FAILED', code: 'USER_QUERY_FAILED' }, { status: 503 }); }
}

async function mutate(request: Request, context: RouteContext, deletion = false) {
  const { username } = await context.params;
  const initial = await authorizeUserOperation(request, deletion ? 'delete' : 'update', username);
  if (!initial.ok) return initial.response;
  let operations: UserOperation[] = [deletion ? 'delete' : 'update'];
  let committed = false;
  try {
    const rate = await enforceRateLimit(`users:update:${initial.auth.user}`, 40, 60);
    if (!rate.ok) return rate.response;
    const body = deletion ? { status: 'disabled' } : requireObject(await request.json());
    if (Object.keys(body).some((key) => !['displayName', 'email', 'role', 'status', 'password', 'confirmPassword', 'action', 'reason'].includes(key))) throw new UserManagementError('INVALID_FIELD', 400);
    if (!Object.keys(body).length) throw new UserManagementError('EMPTY_UPDATE', 400);
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) throw new UserManagementError('INVALID_REASON', 400);
    const updates: Partial<UserDocument> = profileFields(body);
    operations = deletion ? ['delete', 'disable'] : [];
    if (updates.displayName !== undefined || updates.email !== undefined) operations.push('update');
    if (Object.hasOwn(body, 'role')) {
      const normalized = normalizeGovernanceRole(body.role);
      if (!normalized) throw new UserManagementError('INVALID_ROLE', 400);
      updates.role = normalized === 'super_admin' ? 'root' : normalized;
      operations.push('role.change');
    }
    if (body.action !== undefined && !['lock', 'unlock', 'enable', 'disable'].includes(String(body.action))) throw new UserManagementError('INVALID_ACTION', 400);
    if (body.action !== undefined && body.status !== undefined) throw new UserManagementError('CONFLICTING_FIELDS', 400);
    const nextStatus = body.action === 'lock' ? 'locked' : body.action === 'unlock' || body.action === 'enable' ? 'active' : body.action === 'disable' ? 'disabled' : body.status;
    if (nextStatus !== undefined) {
      if (nextStatus !== 'active' && nextStatus !== 'disabled' && nextStatus !== 'locked') throw new UserManagementError('INVALID_STATUS', 400);
      updates.status = nextStatus;
      updates.locked = nextStatus === 'locked';
      updates.security = nextStatus === 'locked'
        ? { lockedAt: new Date().toISOString(), lockReason: typeof body.reason === 'string' ? body.reason.trim() : 'Manual administrator lock' }
        : { failedLoginAttempts: 0 };
      if (!deletion) operations.push(nextStatus === 'locked' ? 'lock' : nextStatus === 'disabled' ? 'disable' : body.action === 'unlock' ? 'unlock' : 'enable');
    }
    if (Object.hasOwn(body, 'password')) {
      if (!isPasswordStrong(body.password, username)) throw new UserManagementError(PASSWORD_POLICY_MESSAGE, 400);
      if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) throw new UserManagementError('PASSWORD_MISMATCH', 400);
      updates.passwordHash = await bcrypt.hash(body.password, 10);
      updates.security = { ...updates.security, passwordChangedAt: new Date().toISOString() };
      operations.push('password.reset');
    }
    if (!operations.length) throw new UserManagementError('EMPTY_UPDATE', 400);
    const result = await updateUser(username, updates, async (target) => {
      // A status=active update on a locked account is an unlock, including legacy clients.
      if (updates.status === 'active' && (target.status === 'locked' || target.locked)) {
        operations = operations.map((op) => op === 'enable' ? 'unlock' : op);
      }
      await recheckUserPolicy(initial.auth, target, operations, updates.role);
    });
    if (!result) throw new UserManagementError('USER_NOT_FOUND', 404);
    committed = true;
    const operationReason = typeof body.reason === 'string' ? body.reason : undefined;
    for (const operation of operations.filter((op) => op !== 'delete')) await userAudit(request, operation, username, 'success', result.existing, result.next, undefined, operationReason);
    return NextResponse.json({ message: deletion ? 'User disabled; account history was preserved' : 'User updated successfully', user: safeUser(result.next), sessionRevoked: updates.role !== undefined || updates.status !== undefined || updates.passwordHash !== undefined });
  } catch (error) { return userOperationError(error, request, operations[0] || 'update', username, committed); }
}

export const PUT = (request: Request, context: RouteContext) => mutate(request, context);
export const PATCH = PUT;
/** Compatibility: DELETE retires access without physically deleting identity history. */
export const DELETE = (request: Request, context: RouteContext) => mutate(request, context, true);
