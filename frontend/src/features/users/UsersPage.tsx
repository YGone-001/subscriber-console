import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, Edit2, Key, Plus, RefreshCw } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { patchJson, postJson } from '../../lib/api/mutation-client';
import { useRead } from '../../lib/api/use-read';
import { hasPermission } from '../../lib/permissions';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '../../lib/security';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { EmptyState, ErrorState } from '../../components/ui/StatePanel';
import { SkeletonTable } from '../../components/ui/LoadingSkeleton';
import type { CanonicalRole } from '../../types/auth';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const rowsOf = (v: unknown): UnknownRecord[] => {
  const r = asRecord(v);
  return listOf(r.records ?? r.items ?? r.users ?? r.data ?? v);
};
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
const numberValue = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

const VALID_ROLES: CanonicalRole[] = ['admin', 'operator', 'viewer'];

export function UsersPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const users = useRead<unknown>(`/api/users?page=${page}&limit=20&q=${encodeURIComponent(query)}`);
  const rows = rowsOf(users.data);
  const total = numberValue(
    asRecord(users.data).total ?? asRecord(asRecord(users.data).pagination).total ?? rows.length,
  );

  const canCreate = hasPermission(user, 'users.create');
  const canUpdate = hasPermission(user, 'users.update');
  const canDisable = hasPermission(user, 'users.disable');
  const canResetPassword = hasPermission(user, 'users.reset-password');

  // Modal states
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [isResetPwOpen, setIsResetPwOpen] = useState(false);
  const [activeUsername, setActiveUsername] = useState<string | null>(null);

  // Form states
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<CanonicalRole>('operator');
  const [editStatus, setEditStatus] = useState<string>('active');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await users.mutate();
  };

  // 1. Update User: PATCH /api/users/{username}
  const handleEdit = async () => {
    if (!activeUsername) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await patchJson(`/api/users/${encodeURIComponent(activeUsername)}`, {
        displayName: editDisplayName.trim() || undefined,
        email: editEmail.trim() || undefined,
        role: editRole,
        status: editStatus,
      });
      setIsEditOpen(false);
      setActiveUsername(null);
      setNotice({ type: 'success', message: `User ${activeUsername} updated successfully.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 2. Disable User: POST /api/users/{username}/disable
  const handleDisable = async () => {
    if (!activeUsername) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/users/${encodeURIComponent(activeUsername)}/disable`);
      setIsDisableOpen(false);
      setActiveUsername(null);
      setNotice({ type: 'success', message: `User ${activeUsername} disabled successfully.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Disable failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 3. Reset Password: POST /api/users/{username}/password-reset
  const handleResetPassword = async () => {
    if (!activeUsername) return;
    if (!isPasswordStrong(newPassword, activeUsername)) {
      setNotice({ type: 'error', message: PASSWORD_POLICY_MESSAGE });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/users/${encodeURIComponent(activeUsername)}/password-reset`, {
        password: newPassword,
      });
      setIsResetPwOpen(false);
      setActiveUsername(null);
      setNewPassword('');
      setNotice({ type: 'success', message: `Password reset successfully for ${activeUsername}.` });
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
          <h1>Users</h1>
        </div>
        <button type="button" className="read-refresh" onClick={() => void refreshData()}>
          <RefreshCw size={16} />
          {t('refresh')}
        </button>
      </header>

      {notice && (
        <div className={`notice-box ${notice.type}`} role="status">
          <span>{notice.message}</span>
        </div>
      )}

      <div className="action-toolbar">
        <label className="read-search">
          {t('search')}
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search by username or email..."
          />
        </label>
        {canCreate && (
          <Link to="/users/create" className="btn-primary">
            <Plus size={16} />
            Create User
          </Link>
        )}
      </div>

      {users.isLoading ? (
        <SkeletonTable rows={6} />
      ) : users.error ? (
        <ErrorState title={t('error_title')} message={users.error.message} retryLabel={t('refresh')} onRetry={() => void refreshData()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('empty_title')} description={t('empty_generic_body')} />
      ) : (
        <>
          <p className="read-summary">{total} {t('records')}</p>
          <div className="read-table-wrap">
            <table className="read-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Display Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const uName = text(row.username);
                  const status = text(row.status).toLowerCase();
                  return (
                    <tr key={uName}>
                      <td data-label="Username">{uName}</td>
                      <td data-label="Display Name">{text(row.displayName)}</td>
                      <td data-label="Role">{text(row.role)}</td>
                      <td data-label="Status">
                        <span className={`badge badge-${status}`}>{text(row.status)}</span>
                      </td>
                      <td data-label="Last Login">{text(row.lastLoginAt)}</td>
                      <td data-label="Actions">
                        <div className="table-actions">
                          <Link to={`/users/${encodeURIComponent(uName)}`} className="btn-secondary btn-sm">
                            {t('details')}
                          </Link>
                          {canUpdate && (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              title="Edit User"
                              onClick={() => {
                                setActiveUsername(uName);
                                setEditDisplayName(text(row.displayName));
                                setEditEmail(text(row.email));
                                setEditRole((row.role as CanonicalRole) || 'operator');
                                setEditStatus(text(row.status));
                                setIsEditOpen(true);
                              }}
                            >
                              <Edit2 size={14} />
                            </button>
                          )}
                          {canResetPassword && (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              title="Reset Password"
                              onClick={() => {
                                setActiveUsername(uName);
                                setNewPassword('');
                                setIsResetPwOpen(true);
                              }}
                            >
                              <Key size={14} />
                            </button>
                          )}
                          {canDisable && status !== 'disabled' && (
                            <button
                              type="button"
                              className="btn-danger btn-sm"
                              title="Disable User"
                              onClick={() => {
                                setActiveUsername(uName);
                                setIsDisableOpen(true);
                              }}
                            >
                              <Ban size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <nav className="read-pagination">
            <button type="button" disabled={page === 1} onClick={() => setPage((v) => v - 1)}>{t('previous')}</button>
            <span>{page}</span>
            <button type="button" disabled={rows.length < 20} onClick={() => setPage((v) => v + 1)}>{t('next')}</button>
          </nav>
        </>
      )}

      {/* Modal 1: Edit User */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title={`Edit User: ${activeUsername}`}
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
          <label htmlFor="edit-user-display">Display Name</label>
          <input
            id="edit-user-display"
            className="form-input"
            value={editDisplayName}
            onChange={(e) => setEditDisplayName(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="edit-user-email">Email</label>
          <input
            id="edit-user-email"
            type="email"
            className="form-input"
            value={editEmail}
            onChange={(e) => setEditEmail(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="edit-user-role">Role</label>
          <select
            id="edit-user-role"
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
          <label htmlFor="edit-user-status">Status</label>
          <select
            id="edit-user-status"
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
        title={`Reset Password for: ${activeUsername}`}
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
          <label htmlFor="reset-user-pw">New Password *</label>
          <input
            id="reset-user-pw"
            type="password"
            className="form-input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
          <p className="form-help">{PASSWORD_POLICY_MESSAGE}</p>
        </div>
      </Modal>

      {/* Confirmation: Disable User */}
      <ConfirmDialog
        isOpen={isDisableOpen}
        onClose={() => setIsDisableOpen(false)}
        onConfirm={() => void handleDisable()}
        title="Disable User Account"
        description={`Are you sure you want to disable user account ${activeUsername}? Active sessions will be invalidated.`}
        confirmLabel="Disable User"
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
