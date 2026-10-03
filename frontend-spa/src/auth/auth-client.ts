import type { AuthState } from '../types/auth';

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
