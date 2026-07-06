// Trigger reload
import { NextResponse } from 'next/server';
import { redis, scanAll } from '@/lib/redis';
import bcrypt from 'bcryptjs';
import { logAudit } from '@/lib/audit';
import { requireRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '@/lib/security';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const auth = requireRole(request, 'root');
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`users:list:${auth.auth.user}`, 60, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const keys = await scanAll('SYS_USER:*');

    if (keys.length === 0) {
      return NextResponse.json({ users: [] });
    }

    const pipeline = redis.pipeline();
    keys.forEach(k => pipeline.get(k));
    const results = await pipeline.exec() || [];

    const users = results.map(r => {
      if (!r[1]) return null;
      try {
        const u = JSON.parse(r[1] as string);
        delete u.passwordHash;
        return u;
      } catch(e) { return null; }
    }).filter(Boolean);

    return NextResponse.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireRole(request, 'root');
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

    const exists = await redis.exists(`SYS_USER:${username}`);
    if (exists) {
      return NextResponse.json({ error: 'User already exists' }, { status: 409 });
    }

    const hash = await bcrypt.hash(password, 10);
    const newUser = {
      username,
      passwordHash: hash,
      role,
      status: 'active',
      createdAt: new Date().toISOString(),
      createdBy: auth.auth.user
    };

    await redis.set(`SYS_USER:${username}`, JSON.stringify(newUser));
    logAudit('CREATE', `SYS_USER:${username}`, null, { username, role }, request);

    return NextResponse.json({ message: 'User created successfully' }, { status: 201 });
  } catch (error) {
    console.error('Error creating user:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
