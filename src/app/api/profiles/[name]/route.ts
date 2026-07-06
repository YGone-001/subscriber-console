import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { logAudit } from '@/lib/audit';
import { requireAuth, requireRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { saveProfileVersion } from '@/lib/profileVersions';

export const dynamic = 'force-dynamic';

/**
 * GET /api/profiles/[name]
 * 获取单个 Profile 的完整配置数据
 * 用于编辑器加载 和 Subscriber 模板注入
 */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`profiles:detail:${auth.auth.user}`, 120, 60);
  if (!rateLimit.ok) return rateLimit.response;

  if (!/^[a-zA-Z0-9_\s-]+$/.test(name)) return NextResponse.json({ error: 'Invalid profile name format' }, { status: 400 });
  try {
    const raw = await redis.get(`PROFILE:${name}`);
    if (!raw) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const profile = JSON.parse(raw);
    return NextResponse.json({ profile });
  } catch (error) {
    console.error('Error fetching profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * PUT /api/profiles/[name]
 * 更新指定 Profile 的全量配置
 * 前端提交的数据结构应包含 auth, ambr, sliceList 三个核心字段
 */
export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const auth = requireRole(request, 'root');
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`profiles:update:${auth.auth.user}`, 30, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const body = await request.json();

    // 获取现有数据以保留 createdAt 等元信息
    const existingRaw = await redis.get(`PROFILE:${name}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    if (existingRaw) {
      await saveProfileVersion(name, existing, auth.auth.user, 'UPDATE');
    }

    // 合并更新数据，保留创建时间
    const updated = {
      ...existing,
      ...body,
      title: body.title || name,
      createdAt: existing.createdAt || new Date().toISOString(),
      createdBy: existing.createdBy || auth.auth.user,
      updatedAt: new Date().toISOString(),
      updatedBy: auth.auth.user
    };

    await redis.set(`PROFILE:${name}`, JSON.stringify(updated));

    logAudit('PROFILE_UPDATE', name, existing, updated, request);

    return NextResponse.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * DELETE /api/profiles/[name]
 * 删除指定 Profile
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const auth = requireRole(request, 'root');
  if (!auth.ok) return auth.response;
  const rateLimit = await enforceRateLimit(`profiles:delete:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  try {
    const existingRaw = await redis.get(`PROFILE:${name}`);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    if (existing) {
      await saveProfileVersion(name, existing, auth.auth.user, 'DELETE');
    }

    await redis.del(`PROFILE:${name}`);

    logAudit('PROFILE_DELETE', name, existing, null, request);

    return NextResponse.json({ message: 'Profile deleted successfully' });
  } catch (error) {
    console.error('Error deleting profile:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
