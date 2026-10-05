import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { safeLocalDestination } from './auth-state';
import type { LoginFailure } from '../types/auth';
import { useAuth } from '../providers/AuthProvider';
import { useI18n } from '../providers/I18nProvider';

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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const { refresh } = useAuth();
  const { t } = useI18n();
  const sessionExpired = new URLSearchParams(location.search).get('reason') === 'session-expired';

  useEffect(() => {
    if (retryAfter <= 0) return;
    const timeout = window.setTimeout(() => setRetryAfter((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timeout);
  }, [retryAfter]);

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
        await refresh();
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
    ? t('invalid_credentials')
    : failure === 'rate_limited'
      ? t('rate_limited', { seconds: retryAfter || 1 })
      : failure === 'service_failure'
        ? t('auth_unavailable')
        : null;

  return (
    <main className="login-page" aria-labelledby="login-title">
      <section className="login-card">
        <div className="brand-lockup"><span className="brand-mark"><img src="/images/xCloud_picture.png" alt={t('brand_alt')} width={1254} height={1254} /></span><span className="brand-name">xCloud</span></div>
        <p className="eyebrow">{t('brand_tagline')}</p>
        <h1 id="login-title">{t('sign_in')}</h1>
        {sessionExpired ? <p className="session-message" role="status">{t('session_expired')}</p> : null}
        <form onSubmit={submit}>
          <label>
            {t('username')}
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            {t('password')}
            <span className="password-field"><input name="password" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" required /><button type="button" onClick={() => setPasswordVisible((visible) => !visible)} aria-label={passwordVisible ? t('hide_password') : t('show_password')}>{passwordVisible ? 'Hide' : 'Show'}</button></span>
          </label>
          {message ? <p className="form-error" role="alert">{message}</p> : null}
          <button type="submit" disabled={loading || retryAfter > 0}>{loading ? t('signing_in') : t('sign_in')}</button>
        </form>
      </section>
    </main>
  );
}
