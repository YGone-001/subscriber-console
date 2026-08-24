import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';
import { safeUser, updateUser } from '@/server/repositories/userRepository';
import type { UserRole } from '@/lib/authz';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ username: string }>;
};

function isValidRole(role: unknown): role is UserRole {
  return role === 'root' || role === 'operator' || role === 'viewer';
}

export async function PUT(request: Request, { params }: RouteContext) {
  const { username } = await params;
  try {
    const auth = requireCapability(request, 'user_admin');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:update:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const isSelf = auth.auth.user === username;
    const body = await request.json();
    const updates: { role?: UserRole; status?: 'active' | 'disabled'; passwordHash?: string } = {};

    if (body.role && !isSelf) {
      if (!isValidRole(body.role)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
      updates.role = body.role;
    }

    if (body.status && !isSelf) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      updates.status = body.status;
    }

    if (body.password) {
      if (!isPasswordStrong(body.password)) {
        return NextResponse.json({ error: PASSWORD_POLICY_MESSAGE }, { status: 400 });
      }
      updates.passwordHash = await bcrypt.hash(body.password, 10);
    }

    const result = await updateUser(username, updates);
    if (!result) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    logAudit('UPDATE', `SYS_USER:${username}`, safeUser(result.existing), safeUser(result.next), request);
    return NextResponse.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const { username } = await params;
  try {
    const auth = requireCapability(request, 'user_admin');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:disable:${auth.auth.user}`, 10, 60);
    if (!rateLimit.ok) return rateLimit.response;

    if (username === 'admin' || auth.auth.user === username) {
      return NextResponse.json({ error: 'Cannot disable the admin or yourself' }, { status: 403 });
    }

    const result = await updateUser(username, { status: 'disabled' });
    if (!result) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    logAudit('UPDATE', `SYS_USER:${username}`, safeUser(result.existing), safeUser(result.next), request);
    return NextResponse.json({ message: 'User disabled; account history was preserved' });
  } catch (error) {
    console.error('Error disabling user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
