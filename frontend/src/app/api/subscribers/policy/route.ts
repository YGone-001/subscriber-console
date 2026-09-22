import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/rateLimit';
import { OCS_OPERATIONS, evaluateOcsOperation } from '@/server/ocsGovernanceRegistry';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const definition = evaluateOcsOperation(OCS_OPERATIONS.PLAN_ASSIGN);
  const auth = requirePermission(request, definition.permission);
  if (!auth.ok) return auth.response;
  if (!definition.executable) {
    return NextResponse.json(
      { error: definition.disabledCode || 'OCS_PLAN_ASSIGN_NOT_SUPPORTED', code: definition.disabledCode || 'OCS_PLAN_ASSIGN_NOT_SUPPORTED' },
      { status: 409 }
    );
  }

  const rateLimit = await enforceRateLimit(`subscribers:policy:${auth.auth.user}`, 20, 60);
  if (!rateLimit.ok) return rateLimit.response;

  return NextResponse.json({ error: 'OCS_PLAN_ASSIGN_NOT_SUPPORTED', code: 'OCS_PLAN_ASSIGN_NOT_SUPPORTED' }, { status: 409 });
}
