import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/authz';
import { ROLE_CAPABILITIES, permissionsFor, normalizeGovernanceRole } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = requireAuth(request);
  if (!auth.ok) {
    auth.response.headers.set('Cache-Control', 'no-store');
    return auth.response;
  }

  const res = NextResponse.json({
    username: auth.auth.user,
    role: auth.auth.role,
    databaseRole: auth.auth.role,
    normalizedRole: normalizeGovernanceRole(auth.auth.role),
    capabilities: ROLE_CAPABILITIES[normalizeGovernanceRole(auth.auth.role) ?? 'viewer'],
    // Additive catalog information. Legacy endpoints still enforce capabilities.
    governanceRole: normalizeGovernanceRole(auth.auth.role),
    permissions: permissionsFor({ role: auth.auth.role }),
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
