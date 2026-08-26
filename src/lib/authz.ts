import { NextResponse } from 'next/server';
import { capabilityAllowed, capabilityDecision, hasPermission, normalizeGovernanceRole, type Capability, type CapabilityGuardOptions, type Permission } from '@/lib/permissions';
import { scheduleAuditLog } from '@/lib/audit';
import { auditRequestContext } from '@/lib/audit/record';
import type { RoleKey } from '@/types/iam';

export type UserRole = RoleKey;

export type AuthContext = {
  user: string;
  role: UserRole;
  sessionVersion: number;
};

type AuthResult =
  | { ok: true; auth: AuthContext }
  | { ok: false; response: NextResponse };

export function requireAuth(request: Request): AuthResult {
  const user = request.headers.get('x-user');
  const role = request.headers.get('x-user-role');
  if (!user || !normalizeGovernanceRole(role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized', code: 'AUTH_INVALID_TOKEN' }, { status: 401 }),
    };
  }

  return {
    ok: true,
    auth: {
      user,
      role: role as UserRole,
      sessionVersion: Number(request.headers.get('x-user-session-version') ?? 0),
    },
  };
}

export function requireAnyRole(request: Request, allowedRoles: UserRole[]): AuthResult {
  const authResult = requireAuth(request);
  if (!authResult.ok) return authResult;

  if (!allowedRoles.some((role) => normalizeGovernanceRole(role) === normalizeGovernanceRole(authResult.auth.role))) {
    recordPermissionDenied(request, authResult.auth, { allowedRoles });
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden: Insufficient permissions', code: 'PERMISSION_DENIED' }, { status: 403 }),
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
    recordPermissionDenied(request, authResult.auth, { capability, decision });
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Forbidden: Insufficient permissions',
          code: 'PERMISSION_DENIED',
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

function recordPermissionDenied(request: Request, auth: AuthContext, metadata: Record<string, unknown>) {
  scheduleAuditLog({
    actor: { type: 'user', username: auth.user, role: auth.role },
    module: 'security',
    action: 'authorization.denied',
    resource: { type: 'api', id: new URL(request.url).pathname },
    result: 'denied',
    metadata,
    ...auditRequestContext(request),
  });
}

/** Called inside a protected Route Handler, after Proxy has verified the JWT. */
export function requirePermission(request: Request, permission: Permission): AuthResult {
  const auth = requireAuth(request);
  if (!auth.ok) return auth;
  // Do not turn malformed roles into a viewer grant in the new permission boundary.
  const rawRole = request.headers.get('x-user-role');
  if (rawRole !== auth.auth.role || !hasPermission({ role: auth.auth.role }, permission)) {
    recordPermissionDenied(request, auth.auth, { permission });
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden: Insufficient permissions', code: 'PERMISSION_DENIED', permission }, { status: 403 }),
    };
  }
  return auth;
}
