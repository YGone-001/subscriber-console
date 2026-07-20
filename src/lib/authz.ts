import { NextResponse } from 'next/server';
import { capabilityAllowed, capabilityDecision, type Capability, type CapabilityGuardOptions } from '@/lib/permissions';

export type UserRole = 'root' | 'operator' | 'viewer';

export type AuthContext = {
  user: string;
  role: UserRole;
};

type AuthResult =
  | { ok: true; auth: AuthContext }
  | { ok: false; response: NextResponse };

function normalizeRole(role: string | null): UserRole {
  if (role === 'root' || role === 'operator' || role === 'viewer') return role;
  return 'viewer';
}

export function requireAuth(request: Request): AuthResult {
  const user = request.headers.get('x-user');
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return {
    ok: true,
    auth: {
      user,
      role: normalizeRole(request.headers.get('x-user-role')),
    },
  };
}

export function requireAnyRole(request: Request, allowedRoles: UserRole[]): AuthResult {
  const authResult = requireAuth(request);
  if (!authResult.ok) return authResult;

  if (!allowedRoles.includes(authResult.auth.role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden: Insufficient permissions' }, { status: 403 }),
    };
  }

  return authResult;
}

export function requireRole(request: Request, role: UserRole): AuthResult {
  return requireAnyRole(request, [role]);
}

export function requireCapability(request: Request, capability: Capability, options: CapabilityGuardOptions = {}): AuthResult {
  const authResult = requireAuth(request);
  if (!authResult.ok) return authResult;

  const decision = capabilityDecision(authResult.auth.role, capability);
  if (!capabilityAllowed(decision, options)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Forbidden: Insufficient permissions',
          capability,
          decision,
          requiresApproval: decision === 'approval',
        },
        { status: 403 }
      ),
    };
  }

  return authResult;
}
