import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { safeLocalDestination } from './auth-state';
import type { LoginFailure } from '../types/auth';

function retryAfterSeconds(value: string | null): number {
  const seconds = Number.parseInt(value ?? '', 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<LoginFailure | null>(null);
  const [retryAfter, setRetryAfter] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    setLoading(true);
    setFailure(null);
    setRetryAfter(0);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        const destination = safeLocalDestination(new URLSearchParams(location.search).get('from'));
        navigate(destination, { replace: true });
        return;
      }
      if (response.status === 401) setFailure('invalid_credentials');
      else if (response.status === 429) {
        setFailure('rate_limited');
        setRetryAfter(retryAfterSeconds(response.headers.get('Retry-After')));
      } else setFailure('service_failure');
    } catch {
      setFailure('service_failure');
    } finally {
      setLoading(false);
    }
  }

  const message = failure === 'invalid_credentials'
    ? 'Invalid credentials.'
    : failure === 'rate_limited'
      ? `Too many attempts. Retry after ${retryAfter || 'a short'} seconds.`
      : failure === 'service_failure'
        ? 'Authentication service is unavailable.'
        : null;

  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">xCloud</p>
        <h1>Migration foundation sign in</h1>
        <p>Use the existing Go authentication authority to continue.</p>
        <form onSubmit={submit}>
          <label>
            Username
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {message ? <p className="form-error" role="alert">{message}</p> : null}
          <button type="submit" disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  );
}
