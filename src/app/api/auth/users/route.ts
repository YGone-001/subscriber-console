import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { logAudit } from '@/lib/audit';
import { requireCapability } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';
import { createUser, listUsers } from '@/server/repositories/userRepository';
import type { UserRole } from '@/lib/authz';

export const dynamic = 'force-dynamic';

function isValidRole(role: unknown): role is UserRole {
  return role === 'root' || role === 'operator' || role === 'viewer';
}

export async function GET(request: Request) {
  try {
    const auth = requireCapability(request, 'user_admin');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:list:${auth.auth.user}`, 60, 60);
    if (!rateLimit.ok) return rateLimit.response;

    return NextResponse.json({ users: await listUsers() });
  } catch (error) {
    console.error('Error fetching users:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireCapability(request, 'user_admin');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:create:${auth.auth.user}`, 15, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { username, password, role } = await request.json();
    if (!username || !password || !role) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!isPasswordStrong(password)) {
      return NextResponse.json({ error: PASSWORD_POLICY_MESSAGE }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return NextResponse.json({ error: 'Invalid username format' }, { status: 400 });
    }
    if (!isValidRole(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    const hash = await bcrypt.hash(password, 10);
    const newUser = await createUser({
      username,
      passwordHash: hash,
      role,
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: auth.auth.user,
    });

    logAudit('CREATE', `SYS_USER:${username}`, null, { username: newUser.username, role: newUser.role }, request);
    return NextResponse.json({ message: 'User created successfully' }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_EXISTS') {
      return NextResponse.json({ error: 'User already exists' }, { status: 409 });
    }

    console.error('Error creating user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
