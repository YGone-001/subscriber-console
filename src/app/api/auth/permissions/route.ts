import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { ROLE_CAPABILITIES, permissionsFor, normalizeGovernanceRole } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    username: auth.auth.user,
    role: auth.auth.role,
    capabilities: ROLE_CAPABILITIES[auth.auth.role],
    // Additive catalog information. Legacy endpoints still enforce capabilities.
    governanceRole: normalizeGovernanceRole(auth.auth.role),
    permissions: permissionsFor({ role: auth.auth.role }),
  });
}
