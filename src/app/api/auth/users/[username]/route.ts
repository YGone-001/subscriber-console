import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import bcrypt from 'bcryptjs';
import { logAudit } from '@/lib/audit';
import { requireRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function PUT(request: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  try {
    const auth = requireRole(request, 'root');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:update:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    // Root cannot modify their own status via this generic endpoint to prevent lockouts
    const isSelf = auth.auth.user === username;

    const userRaw = await redis.get(`SYS_USER:${username}`);
    if (!userRaw) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const user = JSON.parse(userRaw as string);
    const body = await request.json();
    const oldUser = { ...user };

    if (body.role && !isSelf) {
      user.role = body.role;
    }

    if (body.status && !isSelf) {
      user.status = body.status;
    }

    if (body.password) {
      user.passwordHash = await bcrypt.hash(body.password, 10);
    }

    await redis.set(`SYS_USER:${username}`, JSON.stringify(user));

    const auditSafeUser = { ...user };
    delete auditSafeUser.passwordHash;
    const auditSafeOld = { ...oldUser };
    delete auditSafeOld.passwordHash;

    logAudit('UPDATE', `SYS_USER:${username}`, auditSafeOld, auditSafeUser, request);

    return NextResponse.json({ message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  try {
    const auth = requireRole(request, 'root');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:delete:${auth.auth.user}`, 10, 60);
    if (!rateLimit.ok) return rateLimit.response;

    if (username === 'admin' || auth.auth.user === username) {
      return NextResponse.json({ error: 'Cannot delete the admin or yourself' }, { status: 403 });
    }

    const userRaw = await redis.get(`SYS_USER:${username}`);
    if (!userRaw) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    await redis.del(`SYS_USER:${username}`);

    const oldUser = JSON.parse(userRaw as string);
    delete oldUser.passwordHash;
    logAudit('DELETE', `SYS_USER:${username}`, oldUser, null, request);

    return NextResponse.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
