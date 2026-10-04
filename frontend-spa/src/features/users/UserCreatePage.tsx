import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { postJson } from '../../lib/api/mutation-client';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '../../lib/security';
import type { CanonicalRole } from '../../types/auth';

const VALID_ROLES: CanonicalRole[] = ['admin', 'operator', 'viewer'];

export function UserCreatePage() {
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CanonicalRole>('operator');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isStrong = isPasswordStrong(password, username.trim() || undefined);
  const passwordsMatch = password === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUser = username.trim();
    if (!trimmedUser) {
      setError('Username is required.');
      return;
    }
    if (!displayName.trim()) {
      setError('Display name is required.');
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please provide a valid email address.');
      return;
    }
    if (!isStrong) {
      setError(PASSWORD_POLICY_MESSAGE);
      return;
    }
    if (!passwordsMatch) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await postJson('/api/users', {
        username: trimmedUser,
        password,
        displayName: displayName.trim(),
        email: email.trim(),
        role,
      });
      // On success, navigate to the users list
      navigate('/users');
    } catch (err) {
      // Surface server error, preserve non-sensitive fields
      setError(err instanceof Error ? err.message : 'User creation failed.');
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
          <button
            type="button"
            className="icon-button"
            onClick={() => navigate('/users')}
            title="Cancel"
            aria-label="Back to users"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <p className="read-marker">Governed User Administration</p>
            <h1>Create New User</h1>
          </div>
        </div>
      </header>

      {error && (
        <div className="notice-box error" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="login-card" style={{ width: 'min(100%, 36rem)', margin: '0 auto' }}>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="form-group">
            <label htmlFor="create-username">Username *</label>
            <input
              id="create-username"
              className="form-input"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              maxLength={100}
              required
              autoComplete="username"
              placeholder="e.g. jdoe"
            />
          </div>

          <div className="form-group">
            <label htmlFor="create-display-name">Display Name *</label>
            <input
              id="create-display-name"
              className="form-input"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setError(null);
              }}
              maxLength={100}
              required
              placeholder="e.g. John Doe"
            />
          </div>

          <div className="form-group">
            <label htmlFor="create-email">Email (Optional)</label>
            <input
              id="create-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              maxLength={254}
              placeholder="e.g. jdoe@example.com"
            />
          </div>

          <div className="form-group">
            <label htmlFor="create-role">Canonical Role *</label>
            <select
              id="create-role"
              className="form-select"
              value={role}
              onChange={(e) => setRole(e.target.value as CanonicalRole)}
            >
              {VALID_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="create-password">Password *</label>
            <div style={{ display: 'flex', gap: '.4rem' }}>
              <input
                id="create-password"
                type={showPassword ? 'text' : 'password'}
                className="form-input"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                required
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowPassword(!showPassword)}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <div className="password-meter" aria-hidden="true">
              <div
                className={`password-meter-segment ${password.length >= 4 ? 'active-weak' : ''}`}
              />
              <div
                className={`password-meter-segment ${password.length >= 8 ? 'active-medium' : ''}`}
              />
              <div
                className={`password-meter-segment ${isStrong ? 'active-strong' : ''}`}
              />
            </div>
            <p className="form-help">{PASSWORD_POLICY_MESSAGE}</p>
          </div>

          <div className="form-group">
            <label htmlFor="create-confirm-password">Confirm Password *</label>
            <input
              id="create-confirm-password"
              type={showPassword ? 'text' : 'password'}
              className="form-input"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setError(null);
              }}
              required
              autoComplete="new-password"
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.6rem', marginTop: '1rem' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => navigate('/users')}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !username.trim() || !displayName.trim() || !isStrong || !passwordsMatch}
            >
              {submitting ? 'Creating User...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
