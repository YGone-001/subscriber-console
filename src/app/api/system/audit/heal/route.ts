import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { requireAnyRole } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { healSubscriberDocument } from '@/server/repositories/systemAuditRepository';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const auth = requireAnyRole(request, ['root', 'operator']);
    if (!auth.ok) return auth.response;
    const rateLimit = await enforceRateLimit(`system:audit-heal:${auth.auth.user}`, 20, 60);
    if (!rateLimit.ok) return rateLimit.response;

    const { imsi, type, profileName } = await request.json();
    if (!imsi || !type) {
      return NextResponse.json({ error: 'imsi and type are required' }, { status: 400 });
    }

    await healSubscriberDocument(String(imsi), String(type), profileName ? String(profileName) : undefined);
    logAudit('HEAL', String(imsi), null, { type, profileName }, request);

    return NextResponse.json({
      message: `Successfully applied targeted self-healing for ${imsi}`,
    }, { status: 200 });
  } catch (error) {
    console.error('Self-healing API failed:', error);
    return NextResponse.json({ error: 'Self-healing execution failed' }, { status: 500 });
  }
}
