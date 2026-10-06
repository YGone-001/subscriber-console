/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/users/create/page.tsx
 *
 * Adaptations, all at the runtime boundary:
 *   - The App Router navigation hook replaced by React Router's `useNavigate`.
 *   - The historical link component replaced by the React Router link.
 *   - `../components/...` and `../utils` repointed to the ported user-domain
 *     locations.
 *
 * The earlier simplified surface reused the login card and carried hard-coded
 * English copy; the reference form uses the shared password field, the strength
 * meter and the dictionary, and is restored verbatim.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { PasswordField } from '../../components/iam/PasswordField';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { usersApi } from '../../lib/api/users';
import { isPasswordStrong } from '../../lib/security';
import { VALID_ROLES, type RoleKey } from '../../types/iam';
import { PasswordStrengthBar } from './components/PasswordStrengthBar';
import styles from '../../styles/modules/UserDrawer.module.css';

export function UserCreatePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleKey>('operator');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /* Any entered field makes the form dirty; discarding clears every field. */
  const isDirty = Boolean(username || displayName || email || password || confirmPassword);
  const unsavedChanges = useUnsavedChangesGuard(isDirty, () => {
    setUsername('');
    setDisplayName('');
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setError('');
  });

  const handleSubmit = async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) { setError(t('users_err_username')); return; }
    if (!displayName.trim()) { setError(t('users_err_display_name')); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('users_err_email')); return; }
    if (!isPasswordStrong(password, trimmedUsername)) { setError(t('users_err_password')); return; }
    if (password !== confirmPassword) { setError(t('users_err_password_match')); return; }
    if (!VALID_ROLES.includes(role)) { setError(t('users_err_role')); return; }

    setSaving(true);
    setError('');
    try {
      await usersApi.create({
        username: trimmedUsername,
        password,
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        role,
      });
      navigate('/users');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('users_err_create'));
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <Link to="/users" className="btn-icon" title={t('cancel')}>
            <ArrowLeft size={18} />
          </Link>
          <h1>{t('users_create_action')}</h1>
        </div>
      </div>

      <div className={`${styles.drawerBody} ${styles.createFormNarrow}`}>
        <section className={styles.formSection}>
          <h3>{t('users_form_basic')}</h3>
          <label>
            <span>{t('users_username')} *</span>
            <input type="text" className="form-input" value={username} maxLength={100} required
              onChange={(event) => { setUsername(event.target.value); setError(''); }} autoComplete="username" />
          </label>
          <label>
            <span>{t('users_display_name')} *</span>
            <input type="text" className="form-input" value={displayName} maxLength={100} required
              onChange={(event) => { setDisplayName(event.target.value); setError(''); }} autoComplete="name" />
          </label>
          <label>
            <span>{t('users_email')} <small>{t('users_optional')}</small></span>
            <input type="email" className="form-input" value={email} maxLength={254}
              onChange={(event) => { setEmail(event.target.value); setError(''); }} autoComplete="email" />
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t('users_form_role')}</h3>
          <label>
            <span>{t('users_role')} *</span>
            <select className="form-input" value={role} onChange={(event) => { setRole(event.target.value as RoleKey); setError(''); }}>
              {VALID_ROLES.map((option) => <option key={option} value={option}>{t(`users_${option}`)}</option>)}
            </select>
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t('users_form_security')}</h3>
          <PasswordField id="create-user-password" label={t('users_password_new')}
            value={password} onChange={(value) => { setPassword(value); setError(''); }}
            visible={passwordVisible} setVisible={setPasswordVisible}
            placeholder={t('users_password_new')} autoComplete="new-password" />
          <PasswordStrengthBar password={password} />
          <PasswordField id="create-user-password-confirm" label={t('users_password_confirm')}
            value={confirmPassword} onChange={(value) => { setConfirmPassword(value); setError(''); }}
            visible={confirmVisible} setVisible={setConfirmVisible}
            placeholder={t('users_password_confirm')} autoComplete="new-password"
            onEnter={() => void handleSubmit()} />
        </section>

        {error ? <p className={styles.formError}>{error}</p> : null}

        <div className={styles.editActions}>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void handleSubmit()}>
            {saving ? t('saving') : t('users_create_action')}
          </button>
          <Link to="/users" className="btn btn-ghost">{t('cancel')}</Link>
        </div>
      </div>

      <UnsavedChangesDialog
        open={unsavedChanges.isPromptOpen}
        title={t('unsaved_changes_title')}
        description={t('unsaved_changes_description')}
        keepEditingLabel={t('unsaved_changes_keep_editing')}
        discardLabel={t('unsaved_changes_discard')}
        onKeepEditing={unsavedChanges.keepEditing}
        onDiscard={unsavedChanges.discardChanges}
      />
    </div>
  );
}
