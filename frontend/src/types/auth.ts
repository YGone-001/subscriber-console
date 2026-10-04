export type AuthState = 'authenticated' | 'unauthenticated' | 'unavailable';

export type SessionState = AuthState | 'checking';

export type CanonicalRole = 'admin' | 'operator' | 'viewer';
export type UserStatus = 'active' | 'disabled' | 'locked';

export interface AuthUser {
  username: string;
  role: CanonicalRole;
  status: UserStatus;
  normalizedRole?: CanonicalRole;
  permissions?: string[];
  locked?: boolean;
}

export type LoginFailure = 'invalid_credentials' | 'rate_limited' | 'service_failure';
