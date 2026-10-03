import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AuthUnavailablePage } from './AuthUnavailablePage';
import { useAuth } from '../providers/AuthProvider';

export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { state } = useAuth();

  if (state === 'checking') {
    return <main className="state-page">Checking session authority...</main>;
  }

  if (state === 'unavailable') return <AuthUnavailablePage />;

  if (state === 'unauthenticated') {
    const from = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?reason=session-expired&from=${encodeURIComponent(from)}`} replace />;
  }

  return <>{children}</>;
}
