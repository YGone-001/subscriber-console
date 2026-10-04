import { useState } from 'react';
import { Edit2, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import { useRead } from '../../lib/api/use-read';
import { hasPermission } from '../../lib/permissions';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const rowsOf = (v: unknown): UnknownRecord[] => {
  const r = asRecord(v);
  return listOf(r.records ?? r.items ?? r.profiles ?? r.data ?? v);
};
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));

export function ProfilesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const profiles = useRead<unknown>('/api/profiles');
  const allRows = rowsOf(profiles.data);
  const rows = allRows.filter((r) =>
    `${text(r.name)} ${text(r.title)}`.toLowerCase().includes(query.toLowerCase()),
  );

  const detail = useRead<unknown>(selected ? `/api/profiles/${encodeURIComponent(selected)}` : null);
  const stats = useRead<unknown>(selected ? `/api/profiles/${encodeURIComponent(selected)}/stats` : null);
  const versions = useRead<unknown>(selected ? `/api/profiles/${encodeURIComponent(selected)}/versions` : null);

  const canWrite = hasPermission(user, 'profiles.write');

  // Modals & Action states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isRestoreOpen, setIsRestoreOpen] = useState(false);
  const [targetVersionId, setTargetVersionId] = useState<string | null>(null);

  const [createName, setCreateName] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await profiles.mutate();
    if (selected) {
      await detail.mutate();
      await stats.mutate();
      await versions.mutate();
    }
  };

  // 1. Create Profile: POST /api/profiles
  const handleCreate = async () => {
    if (!createName.trim()) {
      setNotice({ type: 'error', message: 'Profile name is required.' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson('/api/profiles', { name: createName.trim() });
      setIsCreateOpen(false);
      setCreateName('');
      setNotice({ type: 'success', message: 'Profile created successfully.' });
      await refreshData();
      setSelected(createName.trim());
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Create profile failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 2. Update Profile: PUT /api/profiles/{name}
  const handleEdit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await putJson(`/api/profiles/${encodeURIComponent(selected)}`, {
        title: editTitle.trim() || undefined,
      });
      setIsEditOpen(false);
      setNotice({ type: 'success', message: 'Profile updated successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 3. Delete Profile: DELETE /api/profiles/{name}
  const handleDelete = async () => {
    if (!selected) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await deleteJson(`/api/profiles/${encodeURIComponent(selected)}`);
      setIsDeleteOpen(false);
      setSelected(null);
      setNotice({ type: 'success', message: 'Profile deleted successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 4. Restore Version: POST /api/profiles/{name}/versions/{versionId}/restore
  const handleRestore = async () => {
    if (!selected || !targetVersionId) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(
        `/api/profiles/${encodeURIComponent(selected)}/versions/${encodeURIComponent(targetVersionId)}/restore`,
      );
      setIsRestoreOpen(false);
      setTargetVersionId(null);
      setNotice({ type: 'success', message: `Version ${targetVersionId} restored for profile ${selected}.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Restore version failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const detailRecord = asRecord(detail.data);
  const versionRows = listOf(asRecord(versions.data).versions ?? versions.data);
  const statRows = stats.data ? [asRecord(stats.data)] : [];

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed Profile Management</p>
          <h1>{t('nav_profile')}</h1>
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search profiles..."
          />
        </label>
        {canWrite && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setCreateName('');
              setIsCreateOpen(true);
            }}
          >
            <Plus size={16} />
            Create Profile
          </button>
        )}
      </div>

      {profiles.isLoading ? (
        <section className="read-state" role="status">{t('loading')}</section>
      ) : profiles.error ? (
        <section className="read-state error" role="alert">
          <p>{profiles.error.message}</p>
          <button type="button" onClick={() => void refreshData()}>{t('refresh')}</button>
        </section>
      ) : rows.length === 0 ? (
        <section className="read-state">{t('empty')}</section>
      ) : (
        <div className="read-table-wrap">
          <table className="read-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = text(row.name);
                return (
                  <tr key={name}>
                    <td data-label="Name">{name}</td>
                    <td data-label="Title">{text(row.title)}</td>
                    <td data-label="Actions">
                      <div className="table-actions">
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => setSelected(name)}
                        >
                          {t('details')}
                        </button>
                        {canWrite && (
                          <button
                            type="button"
                            className="btn-danger btn-sm"
                            title="Delete"
                            onClick={() => {
                              setSelected(name);
                              setIsDeleteOpen(true);
                            }}
                          >
                            <Trash2 size={14} />
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
      )}

      {/* Selected Profile Detail Panel */}
      {selected && (
        <section className="read-collection">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <h2>Selected: {selected}</h2>
            {canWrite && (
              <div style={{ display: 'flex', gap: '.5rem' }}>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setEditTitle(text(detailRecord.title));
                    setIsEditOpen(true);
                  }}
                >
                  <Edit2 size={14} />
                  Edit Profile
                </button>
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => setIsDeleteOpen(true)}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            )}
          </div>

          {detail.isLoading ? (
            <p>{t('loading')}</p>
          ) : (
            <dl className="read-detail">
              {Object.entries(detailRecord).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === 'object' ? JSON.stringify(v) : text(v)}</dd>
                </div>
              ))}
            </dl>
          )}

          {statRows.length > 0 && (
            <section style={{ marginTop: '1rem' }}>
              <h3>Statistics</h3>
              <dl className="read-detail">
                {Object.entries(statRows[0]).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{text(v)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {versionRows.length > 0 && (
            <section style={{ marginTop: '1rem' }}>
              <h3>Version History</h3>
              <div className="read-table-wrap">
                <table className="read-table">
                  <thead>
                    <tr>
                      <th>Version ID</th>
                      <th>Action</th>
                      <th>Saved By</th>
                      <th>Saved At</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versionRows.map((vRow, idx) => {
                      const vId = text(vRow.versionId ?? vRow.version_id ?? idx);
                      return (
                        <tr key={vId}>
                          <td data-label="Version ID">{vId}</td>
                          <td data-label="Action">{text(vRow.action)}</td>
                          <td data-label="Saved By">{text(vRow.savedBy ?? vRow.saved_by)}</td>
                          <td data-label="Saved At">{text(vRow.savedAt ?? vRow.saved_at)}</td>
                          <td data-label="Actions">
                            {canWrite && (
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                onClick={() => {
                                  setTargetVersionId(vId);
                                  setIsRestoreOpen(true);
                                }}
                              >
                                <RotateCcw size={14} />
                                Restore
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </section>
      )}

      {/* Modal 1: Create Profile */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Create Profile"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleCreate()}
              disabled={submitting}
            >
              {submitting ? 'Creating...' : 'Create Profile'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="create-prof-name">Profile Name *</label>
          <input
            id="create-prof-name"
            className="form-input"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="e.g. enterprise_vip"
          />
        </div>
      </Modal>

      {/* Modal 2: Edit Profile */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title={`Edit Profile: ${selected}`}
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
              {submitting ? 'Saving...' : 'Save Profile'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="edit-prof-title">Title / Label</label>
          <input
            id="edit-prof-title"
            className="form-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
          />
        </div>
      </Modal>

      {/* Confirmation 1: Delete Profile */}
      <ConfirmDialog
        isOpen={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title="Delete Profile"
        description={`Permanently delete profile ${selected}? This operation is irreversible.`}
        confirmLabel="Delete Profile"
        isDanger={true}
        isLoading={submitting}
      />

      {/* Confirmation 2: Restore Version */}
      <ConfirmDialog
        isOpen={isRestoreOpen}
        onClose={() => setIsRestoreOpen(false)}
        onConfirm={() => void handleRestore()}
        title="Restore Profile Version"
        description={`Restore profile ${selected} to version ${targetVersionId}? Current settings will be replaced.`}
        confirmLabel="Restore Version"
        isLoading={submitting}
      />
    </section>
  );
}
