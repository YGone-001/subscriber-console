import { normalizeRole } from '../lib/permissions';
import type { AuthState, AuthUser } from '../types/auth';

export function classifyAuthStatus(status: number): AuthState {
  if (status === 200) return 'authenticated';
  if (status === 401) return 'unauthenticated';
  return 'unavailable';
}

export async function getAuthState(requester: typeof fetch = fetch): Promise<AuthState> {
  try {
    const response = await requester('/api/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return classifyAuthStatus(response.status);
  } catch {
    return 'unavailable';
  }
}

export async function getAuthSession(requester: typeof fetch = fetch): Promise<{ state: AuthState; user: AuthUser | null }> {
  try {
    const response = await requester('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    const state = classifyAuthStatus(response.status);
    if (state !== 'authenticated') return { state, user: null };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object') return { state: 'unavailable', user: null };
    const candidate = payload as Record<string, unknown>;
    const role = typeof candidate.role === 'string' ? normalizeRole(candidate.role) : null;
    const status = candidate.status;
    if (typeof candidate.username !== 'string' || !role || (status !== 'active' && status !== 'disabled' && status !== 'locked')) return { state: 'unavailable', user: null };
    return { state, user: { username: candidate.username, role, status } };
  } catch {
    return { state: 'unavailable', user: null };
  }
}
