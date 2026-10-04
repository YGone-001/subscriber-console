import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Ban, Edit2, Key, RefreshCw } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { patchJson, postJson } from '../../lib/api/mutation-client';
import { useRead } from '../../lib/api/use-read';
import { hasPermission } from '../../lib/permissions';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '../../lib/security';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import type { CanonicalRole } from '../../types/auth';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));

const VALID_ROLES: CanonicalRole[] = ['admin', 'operator', 'viewer'];

export function UserDetailPage() {
  const { username } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const encodedUsername = username ? encodeURIComponent(username) : null;
  const userQuery = useRead<unknown>(encodedUsername ? `/api/users/${encodedUsername}` : null);
  const raw = asRecord(userQuery.data);
  const record = asRecord(raw.user ?? raw);
  const entries = Object.entries(record).filter(([k]) => typeof record[k] !== 'object');
  const activityRows = listOf(raw.activity);

  const canUpdate = hasPermission(user, 'users.update');
  const canDisable = hasPermission(user, 'users.disable');
  const canResetPassword = hasPermission(user, 'users.reset-password');
  const status = text(record.status).toLowerCase();

  // Modals & Action states
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [isResetPwOpen, setIsResetPwOpen] = useState(false);

  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<CanonicalRole>('operator');
  const [editStatus, setEditStatus] = useState<string>('active');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await userQuery.mutate();
  };

  const handleEdit = async () => {
    if (!encodedUsername) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await patchJson(`/api/users/${encodedUsername}`, {
        displayName: editDisplayName.trim() || undefined,
        email: editEmail.trim() || undefined,
        role: editRole,
        status: editStatus,
      });
      setIsEditOpen(false);
      setNotice({ type: 'success', message: 'User updated successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisable = async () => {
    if (!encodedUsername) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/users/${encodedUsername}/disable`);
      setIsDisableOpen(false);
      setNotice({ type: 'success', message: 'User disabled successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Disable failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async () => {
    if (!encodedUsername || !username) return;
    if (!isPasswordStrong(newPassword, username)) {
      setNotice({ type: 'error', message: PASSWORD_POLICY_MESSAGE });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/users/${encodedUsername}/password-reset`, {
        password: newPassword,
      });
      setIsResetPwOpen(false);
      setNewPassword('');
      setNotice({ type: 'success', message: 'Password reset successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Password reset failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed User Administration</p>
          <h1>User: {username}</h1>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button type="button" className="read-refresh" onClick={() => void refreshData()}>
            <RefreshCw size={16} />
            {t('refresh')}
          </button>
          {canUpdate && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setEditDisplayName(text(record.displayName));
                setEditEmail(text(record.email));
                setEditRole((record.role as CanonicalRole) || 'operator');
                setEditStatus(text(record.status));
                setIsEditOpen(true);
              }}
            >
              <Edit2 size={16} />
              Edit
            </button>
          )}
          {canResetPassword && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setNewPassword('');
                setIsResetPwOpen(true);
              }}
            >
              <Key size={16} />
              Reset Password
            </button>
          )}
          {canDisable && status !== 'disabled' && (
            <button
              type="button"
              className="btn-danger"
              onClick={() => setIsDisableOpen(true)}
            >
              <Ban size={16} />
              Disable
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice-box ${notice.type}`} role="status">
          <span>{notice.message}</span>
        </div>
      )}

      <button type="button" className="read-back" onClick={() => navigate('/users')}>
        {t('back')}
      </button>

      {userQuery.isLoading ? (
        <section className="read-state" role="status">{t('loading')}</section>
      ) : userQuery.error ? (
        <section className="read-state error" role="alert">
          <p>{userQuery.error.message}</p>
          <button type="button" onClick={() => void refreshData()}>{t('refresh')}</button>
        </section>
      ) : entries.length === 0 ? (
        <section className="read-state">{t('empty')}</section>
      ) : (
        <>
          <dl className="read-detail">
            {entries.map(([key, value]) => (
              <div key={key}>
                <dt>{key.replaceAll('_', ' ')}</dt>
                <dd>{text(value)}</dd>
              </div>
            ))}
          </dl>

          {activityRows.length > 0 && (
            <section className="read-collection">
              <h2>Recent Activity</h2>
              <div className="read-table-wrap">
                <table className="read-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Result</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityRows.map((act, idx) => (
                      <tr key={idx}>
                        <td data-label="Action">{text(act.action)}</td>
                        <td data-label="Result">{text(act.result)}</td>
                        <td data-label="Time">{text(act.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* Modal 1: Edit User */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title={`Edit User: ${username}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsEditOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleEdit()}
              disabled={submitting}
            >
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="detail-edit-name">Display Name</label>
          <input
            id="detail-edit-name"
            className="form-input"
            value={editDisplayName}
            onChange={(e) => setEditDisplayName(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="detail-edit-email">Email</label>
          <input
            id="detail-edit-email"
            type="email"
            className="form-input"
            value={editEmail}
            onChange={(e) => setEditEmail(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="detail-edit-role">Role</label>
          <select
            id="detail-edit-role"
            className="form-select"
            value={editRole}
            onChange={(e) => setEditRole(e.target.value as CanonicalRole)}
          >
            {VALID_ROLES.map((r) => (
              <option key={r} value={r}>
                {r.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="detail-edit-status">Status</label>
          <select
            id="detail-edit-status"
            className="form-select"
            value={editStatus}
            onChange={(e) => setEditStatus(e.target.value)}
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="locked">Locked</option>
          </select>
        </div>
      </Modal>

      {/* Modal 2: Reset Password */}
      <Modal
        isOpen={isResetPwOpen}
        onClose={() => setIsResetPwOpen(false)}
        title={`Reset Password for: ${username}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsResetPwOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleResetPassword()}
              disabled={submitting || !newPassword}
            >
              {submitting ? 'Resetting...' : 'Reset Password'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="detail-reset-pw">New Password *</label>
          <input
            id="detail-reset-pw"
            type="password"
            className="form-input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
          <p className="form-help">{PASSWORD_POLICY_MESSAGE}</p>
        </div>
      </Modal>

      {/* Confirmation: Disable */}
      <ConfirmDialog
        isOpen={isDisableOpen}
        onClose={() => setIsDisableOpen(false)}
        onConfirm={() => void handleDisable()}
        title="Disable User Account"
        description={`Are you sure you want to disable user account ${username}?`}
        confirmLabel="Disable User"
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
