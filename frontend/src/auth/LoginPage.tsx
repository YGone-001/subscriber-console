import { FormEvent, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock, User } from 'lucide-react';
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
    <main className="login-container" aria-labelledby="login-title">
      <div className="login-bg-blob-1" aria-hidden="true" />
      <div className="login-bg-blob-2" aria-hidden="true" />
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo-container">
            <img className="login-logo" src="/images/xCloud_picture.png" alt={t('login_title')} width={1254} height={1254} />
          </div>
          <h1 className="login-title" id="login-title">{t('login_title')}</h1>
          <p className="login-subtitle">{t('login_subtitle')}</p>
        </div>

        <form onSubmit={submit} className="login-form">
          {sessionExpired ? (
            <div className="login-session-container" role="status">
              <div className="login-session-indicator" aria-hidden="true" />
              <span>{t('login_session_expired')}</span>
            </div>
          ) : null}

          {message ? (
            <div className="login-error-container" role="alert" aria-live="assertive">
              <div className="login-error-indicator" aria-hidden="true" />
              <span>{message}</span>
            </div>
          ) : null}

          <div className="input-container">
            <label className="login-field-label" htmlFor="xcloud-login-username">{t('login_username')}</label>
            <div className="input-icon" aria-hidden="true"><User size={18} /></div>
            <input
              id="xcloud-login-username"
              name="username"
              placeholder={t('login_username')}
              autoComplete="username"
              required
              className="login-input"
            />
          </div>

          <div className="input-container">
            <label className="login-field-label" htmlFor="xcloud-login-password">{t('login_password')}</label>
            <div className="input-icon" aria-hidden="true"><Lock size={18} /></div>
            <input
              id="xcloud-login-password"
              name="password"
              type={passwordVisible ? 'text' : 'password'}
              placeholder={t('login_password')}
              autoComplete="current-password"
              required
              className="login-input login-input-password"
            />
            <button
              id="xcloud-password-toggle"
              type="button"
              className="password-toggle"
              aria-label={passwordVisible ? t('login_hide_password') : t('login_show_password')}
              aria-pressed={passwordVisible}
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <button
            id="xcloud-login-submit"
            type="submit"
            className="login-submit-btn"
            disabled={loading || retryAfter > 0}
          >
            <span id="xcloud-login-spinner" hidden={!loading}>
              <Loader2 size={20} className="login-spinner" aria-hidden="true" />
            </span>
            <span id="xcloud-login-submit-text" hidden={loading}>{t('login_button')}</span>
          </button>
        </form>

        <div className="login-footer">{t('login_protected')}</div>
      </div>
    </main>
  );
}
