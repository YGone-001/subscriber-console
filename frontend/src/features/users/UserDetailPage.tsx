/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/users/[username]/page.tsx
 *
 * Adaptations, all at the runtime boundary:
 *   - The App Router parameter hook replaced by React Router's `useParams`. The
 *     router already decodes the segment, so the historical `decodeURIComponent`
 *     is dropped rather than applied a second time.
 *   - The historical link component replaced by the React Router link.
 *   - `useSWR(fetcher)` replaced by the current read client.
 *   - `usePermissions()` replaced by the current session provider plus the shared
 *     management policy, so the same capability call sites keep working.
 *   - `../utils` and `../components/...` repointed to the ported user-domain
 *     locations.
 *
 * The structured sections, badges, lifecycle dialogs, reason capture and
 * last-active-administrator protection are unchanged from the reference.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, KeyRound, Lock, Pencil, Unlock, UserCheck, UserX } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { RoleBadge } from '../../components/iam/RoleBadge';
import { StatusBadge } from '../../components/iam/StatusBadge';
import { ConfirmActionPanel } from '../../components/ui/OperationFeedback';
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '../../components/ui/UnsavedChangesGuard';
import { useRead } from '../../lib/api/use-read';
import { usersApi, type UserDetailResponse } from '../../lib/api/users';
import { mapUserManagementError } from '../../lib/auth-ui';
import { userManagementActions } from '../../lib/userManagementPolicy';
import { normalizeRole, normalizeStatus, formatDateTime, displayValue } from './utils';
import { PasswordResetModal } from './components/PasswordResetModal';
import type { RoleKey } from '../../types/iam';
import styles from '../../styles/modules/UserDrawer.module.css';

type PendingLifecycleAction = 'disable' | 'lock' | 'enable' | 'unlock';

export function UserDetailPage() {
  const { t } = useI18n();
  const { username: routeUsername } = useParams();
  const username = routeUsername ?? '';
  const { user: currentUser } = useAuth();
  const isSelf = !!currentUser && currentUser.username === username;

  const { data, error, mutate } = useRead<UserDetailResponse>(
    username ? `/api/users/${encodeURIComponent(username)}` : null,
  );

  const user = data?.user;
  const normalizedRole = user ? normalizeRole(user.role) : 'viewer';
  const normalizedStatus = user ? normalizeStatus(user.status) : 'active';

  const availableActions = useMemo(() => {
    if (!currentUser || !user) return [];
    return userManagementActions(currentUser, { username: user.username, role: user.role });
  }, [currentUser, user]);

  const canUpdateProfile = availableActions.includes('update');
  const canChangeRole = availableActions.includes('role.change');
  const canResetPassword = availableActions.includes('password.reset');
  const canDisable = availableActions.includes('disable') && normalizedStatus === 'active';
  const canLock = availableActions.includes('lock') && normalizedStatus === 'active';
  const canEnable = availableActions.includes('enable') && normalizedStatus === 'disabled';
  const canUnlock = availableActions.includes('unlock') && normalizedStatus === 'locked';

  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleKey>('operator');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [pendingLifecycleAction, setPendingLifecycleAction] = useState<PendingLifecycleAction | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [showResetModal, setShowResetModal] = useState(false);
  const [notice, setNotice] = useState('');

  /* Editing state is the dirty signal; discarding returns the form to read-only. */
  const unsavedChanges = useUnsavedChangesGuard(editing, () => setEditing(false));

  const startEdit = useCallback(() => {
    if (!user) return;
    setDisplayName(user.displayName || '');
    setEmail(user.email || '');
    setRole(normalizeRole(user.role));
    setFormError('');
    setEditing(true);
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setFormError('');
    try {
      const payload: Record<string, unknown> = {};
      if (displayName !== (user.displayName || '')) payload.displayName = displayName;
      if (email !== (user.email || '')) payload.email = email;
      const currentRole = normalizeRole(user.role);
      if (canChangeRole && role !== currentRole) payload.role = role;

      if (!Object.keys(payload).length) {
        setEditing(false);
        setSaving(false);
        return;
      }

      await usersApi.update(username, payload);
      setEditing(false);
      setNotice(t('users_msg_updated'));
      await mutate();
    } catch (failure) {
      setFormError(mapUserManagementError(failure, t));
    } finally {
      setSaving(false);
    }
  };

  const handleLifecycleAction = async () => {
    if (!pendingLifecycleAction) return;
    setSaving(true);
    setFormError('');
    try {
      const reason = actionReason.trim() || undefined;
      if (pendingLifecycleAction === 'disable') {
        await usersApi.disable(username, reason);
      } else if (pendingLifecycleAction === 'lock') {
        await usersApi.update(username, { status: 'locked', reason });
      } else if (pendingLifecycleAction === 'enable' || pendingLifecycleAction === 'unlock') {
        await usersApi.update(username, { status: 'active', reason });
      }
      setPendingLifecycleAction(null);
      setActionReason('');
      setNotice(t('users_msg_updated'));
      await mutate();
    } catch (failure) {
      setFormError(mapUserManagementError(failure, t));
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordReset = async (targetUsername: string, password: string, reason?: string) => {
    await usersApi.resetPassword(targetUsername, password, reason);
    await mutate();
  };

  const handlePasswordResetSuccess = () => {
    setShowResetModal(false);
    setNotice(t('users_msg_updated'));
    setFormError('');
  };

  if (error) {
    return (
      <div className="page">
        <div className="page-header">
          <Link to="/users" className="btn-icon" title={t('cancel')}><ArrowLeft size={18} /></Link>
          <h1>{t('users_title')}</h1>
        </div>
        <p className={styles.errorText}>{mapUserManagementError(error, t)}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="page">
        <div className="page-header">
          <Link to="/users" className="btn-icon" title={t('cancel')}><ArrowLeft size={18} /></Link>
          <h1>{t('users_title')}</h1>
        </div>
        <p>{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <Link to="/users" className="btn-icon" title={t('cancel')}><ArrowLeft size={18} /></Link>
          <h1>{user.username}</h1>
          {isSelf ? <span className="badge badge-subtle">{t('users_current_user')}</span> : null}
          <RoleBadge role={normalizedRole} />
          <StatusBadge status={normalizedStatus} />
        </div>
        <div className={styles.headerActions}>
          {canUpdateProfile && !editing ? (
            <button type="button" className="btn btn-ghost" onClick={startEdit}>
              <Pencil size={16} /> {t('users_edit_account')}
            </button>
          ) : null}
          {canResetPassword ? (
            <button type="button" className="btn btn-ghost" onClick={() => setShowResetModal(true)}>
              <KeyRound size={16} /> {t('users_reset_password')}
            </button>
          ) : null}
          {canLock ? (
            <button type="button" className="btn btn-ghost" onClick={() => { setFormError(''); setPendingLifecycleAction('lock'); }}>
              <Lock size={16} /> {t('users_lock_account')}
            </button>
          ) : null}
          {canUnlock ? (
            <button type="button" className="btn btn-primary" onClick={() => { setFormError(''); setPendingLifecycleAction('unlock'); }}>
              <Unlock size={16} /> {t('users_unlock_account')}
            </button>
          ) : null}
          {canDisable ? (
            <button type="button" className="btn btn-danger" onClick={() => { setFormError(''); setPendingLifecycleAction('disable'); }}>
              <UserX size={16} /> {t('users_disable_account')}
            </button>
          ) : null}
          {canEnable ? (
            <button type="button" className="btn btn-primary" onClick={() => { setFormError(''); setPendingLifecycleAction('enable'); }}>
              <UserCheck size={16} /> {t('users_enable_account')}
            </button>
          ) : null}
        </div>
      </div>

      {notice ? <p className={styles.successText}>{notice}</p> : null}
      {formError ? <p className={styles.errorText}>{formError}</p> : null}

      <div className={`${styles.drawerBody} ${styles.detailBodyNarrow}`}>
        <section className={styles.formSection}>
          <h3>{t('users_form_basic')}</h3>
          <label>
            <span>{t('users_username')}</span>
            <input className="form-input" value={user.username} disabled />
          </label>
          <label>
            <span>{t('users_display_name')}</span>
            <input
              className="form-input"
              value={editing ? displayName : displayValue(user.displayName)}
              disabled={!editing || !canUpdateProfile}
              maxLength={100}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label>
            <span>{t('users_email')}</span>
            <input
              type="email"
              className="form-input"
              value={editing ? email : displayValue(user.email)}
              disabled={!editing || !canUpdateProfile}
              maxLength={254}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t('users_form_role')}</h3>
          <label>
            <span>{t('users_role')}</span>
            {editing && canChangeRole ? (
              <select className="form-input" value={role} onChange={(event) => setRole(event.target.value as RoleKey)}>
                {(data?.assignableRoles?.length ? data.assignableRoles : ['admin', 'operator', 'viewer']).map((option) => (
                  <option key={option} value={option}>{t(`users_${option}`)}</option>
                ))}
              </select>
            ) : (
              <input className="form-input" value={t(`users_${normalizedRole}`)} disabled />
            )}
          </label>
          <label>
            <span>{t('users_status')}</span>
            <input className="form-input" value={t(`users_${normalizedStatus}`)} disabled />
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t('users_security_state')}</h3>
          <p className={styles.sectionDescription}>{t('users_security_snapshot_note')}</p>
          <label>
            <span>{t('users_status')}</span>
            <div className={styles.statusBadgeSlot}>
              <StatusBadge status={normalizedStatus} />
            </div>
          </label>
          <label>
            <span>{t('users_session_version')}</span>
            <input className="form-input" value={String(user.security?.sessionVersion ?? 0)} disabled />
          </label>
          <label>
            <span>{t('users_failed_logins')}</span>
            <input className="form-input" value={String(user.security?.failedLoginAttempts ?? 0)} disabled />
          </label>
          <label>
            <span>{t('users_last_login')}</span>
            <input className="form-input" value={formatDateTime(user.security?.lastLoginAt || user.lastLoginAt)} disabled />
          </label>
          <label>
            <span>{t('users_last_login_ip')}</span>
            <input className="form-input" value={displayValue(user.security?.lastLoginIp || user.lastLoginIp)} disabled />
          </label>
          <label>
            <span>{t('users_password_changed_at')}</span>
            <input className="form-input" value={formatDateTime(user.security?.passwordChangedAt)} disabled />
          </label>
          {normalizedStatus === 'locked' ? (
            <>
              <label>
                <span>{t('users_locked_at')}</span>
                <input className="form-input" value={formatDateTime(user.security?.lockedAt)} disabled />
              </label>
              <label>
                <span>{t('users_lock_reason')}</span>
                <input className="form-input" value={displayValue(user.security?.lockReason)} disabled />
              </label>
            </>
          ) : null}
        </section>

        <section className={styles.formSection}>
          <h3>{t('users_form_basic')}</h3>
          <label>
            <span>{t('users_created')}</span>
            <input className="form-input" value={formatDateTime(user.createdAt)} disabled />
          </label>
          <label>
            <span>{t('users_updated_at')}</span>
            <input className="form-input" value={formatDateTime(user.updatedAt)} disabled />
          </label>
        </section>

        {editing ? (
          <div className={styles.editActions}>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
              {saving ? t('saving') : t('save')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>{t('cancel')}</button>
          </div>
        ) : null}
      </div>

      {pendingLifecycleAction ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={pendingLifecycleAction === 'disable' || pendingLifecycleAction === 'lock' ? 'warning' : 'info'}
          title={t(
            pendingLifecycleAction === 'disable' ? 'users_disable_account' :
            pendingLifecycleAction === 'lock' ? 'users_lock_account' :
            pendingLifecycleAction === 'unlock' ? 'users_unlock_account' :
            'users_enable_account'
          )}
          message={t(
            pendingLifecycleAction === 'disable' ? 'users_status_disable_desc' :
            pendingLifecycleAction === 'lock' ? 'users_lock_desc' :
            pendingLifecycleAction === 'unlock' ? 'users_unlock_desc' :
            'users_status_enable_desc'
          )}
          confirmLabel={t(
            pendingLifecycleAction === 'disable' ? 'users_disable_account' :
            pendingLifecycleAction === 'lock' ? 'users_lock_account' :
            pendingLifecycleAction === 'unlock' ? 'users_unlock_account' :
            'users_enable_account'
          )}
          cancelLabel={t('cancel')}
          isWorking={saving}
          confirmDisabled={
            (pendingLifecycleAction === 'disable' || pendingLifecycleAction === 'lock')
              ? actionReason.trim().length < 3
              : false
          }
          onConfirm={() => void handleLifecycleAction()}
          onCancel={() => { setPendingLifecycleAction(null); setActionReason(''); }}
        >
          <div className={styles.confirmDetails}>
            <span>{t('users_confirm_object', { target: username })}</span>
            <label>
              {t('users_confirm_reason')}
              <textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} rows={3} />
            </label>
          </div>
        </ConfirmActionPanel>
      ) : null}

      <UnsavedChangesDialog
        open={unsavedChanges.isPromptOpen}
        title={t('unsaved_changes_title')}
        description={t('unsaved_changes_description')}
        keepEditingLabel={t('unsaved_changes_keep_editing')}
        discardLabel={t('unsaved_changes_discard')}
        onKeepEditing={unsavedChanges.keepEditing}
        onDiscard={unsavedChanges.discardChanges}
      />

      <PasswordResetModal
        username={username}
        open={showResetModal}
        onClose={() => setShowResetModal(false)}
        onSuccess={handlePasswordResetSuccess}
        onReset={handlePasswordReset}
      />
    </div>
  );
}
