import { normalizeGovernanceRole } from '@/lib/permissions';
import { getUser } from '@/server/repositories/userRepository';
import type { UserDocument } from '@/server/repositories/userRepository';

export class AccountSessionError extends Error {
  constructor(public readonly code: 'AUTH_INVALID_TOKEN' | 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_DISABLED' | 'ACCOUNT_LOCKED' | 'SESSION_REVOKED') {
    super(code);
  }
}

type SessionClaims = { username?: unknown; role?: unknown; sv?: unknown };

/** Missing versions are the legacy version zero, never a wildcard. */
export function validateAccountSnapshot(claims: SessionClaims, account: (UserDocument & { _id?: unknown }) | null) {
  const tokenRole = normalizeGovernanceRole(claims.role);
  const sv = claims.sv === undefined ? 0 : claims.sv;
  if (typeof claims.username !== 'string' || !claims.username || !tokenRole || !Number.isSafeInteger(sv) || (sv as number) < 0) {
    throw new AccountSessionError('AUTH_INVALID_TOKEN');
  }
  if (!account || account.username !== claims.username) throw new AccountSessionError('ACCOUNT_NOT_FOUND');
  if (account.status === 'locked' || account.locked) throw new AccountSessionError('ACCOUNT_LOCKED');
  if (account.status !== 'active') throw new AccountSessionError('ACCOUNT_DISABLED');
  const normalizedRole = normalizeGovernanceRole(account.role);
  const sessionVersion = account.security?.sessionVersion ?? 0;
  if (!normalizedRole || !Number.isSafeInteger(sessionVersion) || sessionVersion < 0 || sv !== sessionVersion || tokenRole !== normalizedRole) {
    throw new AccountSessionError('SESSION_REVOKED');
  }
  return { userId: String(account._id ?? account.username), username: account.username, role: account.role, normalizedRole, status: account.status, sessionVersion };
}

/** Only call with claims from a verified JWT (or the Proxy's overwritten claims). No cache. */
export async function validateCurrentAccount(claims: SessionClaims) {
  if (typeof claims.username !== 'string' || claims.username.length > 100) throw new AccountSessionError('AUTH_INVALID_TOKEN');
  return validateAccountSnapshot(claims, await getUser(claims.username));
}
