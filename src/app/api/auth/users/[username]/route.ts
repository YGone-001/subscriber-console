import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { logAudit } from '@/lib/audit';
import { requireRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { deleteUser, safeUser, updateUser } from '@/server/repositories/userRepository';
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
    const auth = requireRole(request, 'root');
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
    const auth = requireRole(request, 'root');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:delete:${auth.auth.user}`, 10, 60);
    if (!rateLimit.ok) return rateLimit.response;

    if (username === 'admin' || auth.auth.user === username) {
      return NextResponse.json({ error: 'Cannot delete the admin or yourself' }, { status: 403 });
    }

    const existing = await deleteUser(username);
    if (!existing) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    logAudit('DELETE', `SYS_USER:${username}`, safeUser(existing), null, request);
    return NextResponse.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
