import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getAuthState } from './auth-client';
import { AuthUnavailablePage } from './AuthUnavailablePage';
import type { AuthState } from '../types/auth';

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [state, setState] = useState<AuthState | 'checking'>('checking');

  useEffect(() => {
    let active = true;
    void getAuthState().then((nextState) => {
      if (active) setState(nextState);
    });
    return () => {
      active = false;
    };
  }, [location.key]);

  if (state === 'checking') {
    return <main className="state-page">Checking session authority...</main>;
  }

  if (state === 'unavailable') return <AuthUnavailablePage />;

  if (state === 'unauthenticated') {
    const from = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?from=${encodeURIComponent(from)}`} replace />;
  }

  return <>{children}</>;
}
