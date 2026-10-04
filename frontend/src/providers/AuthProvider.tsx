import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { getAuthSession } from '../auth/auth-client';
import type { AuthUser, SessionState } from '../types/auth';

type AuthContextValue = {
  state: SessionState;
  user: AuthUser | null;
  refresh: () => Promise<unknown>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchSession(): Promise<{ state: SessionState; user: AuthUser | null }> {
  return getAuthSession();
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = useSWR('spa-session-authority', fetchSession, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const refresh = useCallback(() => session.mutate(), [session]);
  useEffect(() => {
    const revalidate = () => { void refresh(); };
    window.addEventListener('xcloud-session-revalidate', revalidate);
    return () => window.removeEventListener('xcloud-session-revalidate', revalidate);
  }, [refresh]);
  const value = useMemo<AuthContextValue>(() => ({
    state: session.isLoading ? 'checking' : (session.data?.state ?? 'unavailable'),
    user: session.data?.user ?? null,
    refresh,
  }), [refresh, session.data, session.isLoading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
