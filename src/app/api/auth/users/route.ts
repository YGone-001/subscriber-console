import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';
import { normalizeGovernanceRole } from '@/lib/permissions';
import { assignableRoles, UserManagementError } from '@/lib/userManagementPolicy';
import { parseUserQuery } from '@/lib/userQuery';
import { createUser, listUsers, queryUsers } from '@/server/repositories/userRepository';
import { authorizeUserOperation, profileFields, recheckUserPolicy, requireObject, userAudit, userOperationError } from '@/server/userManagement';
import { USERNAME_PATTERN, type RoleKey } from '@/types/iam';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requirePermission(request, 'users.read');
  if (!auth.ok) return auth.response;
  try {
    const rate = await enforceRateLimit(`users:list:${auth.auth.user}`, 120, 60);
    if (!rate.ok) return rate.response;
    const url = new URL(request.url);
    const metadata = { assignableRoles: assignableRoles({ username: auth.auth.user, role: auth.auth.role }) };
    // Preserve historical no-query callers. The new console uses /api/users pagination.
    if (url.pathname === '/api/auth/users' && !url.search) return NextResponse.json({ users: await listUsers(), ...metadata });
    const result = await queryUsers(parseUserQuery(url.searchParams));
    return NextResponse.json({ ...result, ...metadata });
  } catch (error) {
    return NextResponse.json({ error: error instanceof UserManagementError ? error.code : 'USER_QUERY_FAILED', code: error instanceof UserManagementError ? error.code : 'USER_QUERY_FAILED' }, { status: error instanceof UserManagementError ? error.status : 503 });
  }
}

export async function POST(request: Request) {
  const auth = await authorizeUserOperation(request, 'create');
  if (!auth.ok) return auth.response;
  let username = 'directory';
  let committed = false;
  try {
    const rate = await enforceRateLimit(`users:create:${auth.auth.user}`, 15, 60);
    if (!rate.ok) return rate.response;
    const body = requireObject(await request.json());
    if (Object.keys(body).some((key) => !['username', 'displayName', 'email', 'password', 'confirmPassword', 'role'].includes(key))) throw new UserManagementError('INVALID_FIELD', 400);
    if (typeof body.username !== 'string' || !USERNAME_PATTERN.test(body.username)) throw new UserManagementError('INVALID_USERNAME', 400);
    username = body.username;
    if (!isPasswordStrong(body.password, username)) throw new UserManagementError(PASSWORD_POLICY_MESSAGE, 400);
    if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) throw new UserManagementError('PASSWORD_MISMATCH', 400);
    const normalized = normalizeGovernanceRole(body.role);
    if (!normalized) throw new UserManagementError('INVALID_ROLE', 400);
    const role: RoleKey = normalized === 'super_admin' ? 'root' : normalized;
    const profile = profileFields(body, true);
    const passwordHash = await bcrypt.hash(body.password, 10);
    const now = new Date().toISOString();
    const user = await createUser({ username, ...profile, passwordHash, role, status: 'active', createdAt: now, updatedAt: now, createdBy: auth.auth.user, security: { sessionVersion: 0, failedLoginAttempts: 0, passwordChangedAt: now } },
      () => recheckUserPolicy(auth.auth, null, ['create'], role));
    committed = true;
    await userAudit(request, 'create', username, 'success', undefined, user);
    return NextResponse.json({ message: 'User created successfully', username }, { status: 201 });
  } catch (error) { return userOperationError(error, request, 'create', username, committed); }
}
