import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, Copy, Edit2, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Modal } from '../../../components/Modal';
import { deleteJson, postJson, putJson } from '../../../lib/api/mutation-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const rowsOf = (v: unknown): UnknownRecord[] => {
  const r = asRecord(v);
  return listOf(r.records ?? r.items ?? r.plans ?? r.data ?? v);
};
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));

export function TariffsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const tariffs = useRead<unknown>(`/api/tariff-plans?page=${page}&limit=20`);
  const rows = rowsOf(tariffs.data);

  const canWrite = hasPermission(user, 'ocs.tariff.write');

  // Modal & Action states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isCloneOpen, setIsCloneOpen] = useState(false);
  const [isEnableOpen, setIsEnableOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);

  // Form states
  const [planIdInput, setPlanIdInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [cloneTargetId, setCloneTargetId] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await tariffs.mutate();
  };

  // 1. Create Tariff Plan: POST /api/tariff-plans
  const handleCreate = async () => {
    if (!planIdInput.trim() || !nameInput.trim()) {
      setNotice({ type: 'error', message: 'Plan ID and Name are required.' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson('/api/tariff-plans', {
        plan_id: planIdInput.trim(),
        name: nameInput.trim(),
        description: descInput.trim() || undefined,
        status: 'active',
      });
      setIsCreateOpen(false);
      setPlanIdInput('');
      setNameInput('');
      setDescInput('');
      setNotice({ type: 'success', message: 'Tariff plan created successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Create failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 2. Update Tariff Plan: PUT /api/tariff-plans/{planId}
  const handleEdit = async () => {
    if (!activePlanId || !nameInput.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await putJson(`/api/tariff-plans/${encodeURIComponent(activePlanId)}`, {
        name: nameInput.trim(),
        description: descInput.trim() || undefined,
      });
      setIsEditOpen(false);
      setActivePlanId(null);
      setNotice({ type: 'success', message: 'Tariff plan updated successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 3. Clone Tariff Plan: POST /api/tariff-plans/{planId}/clone
  const handleClone = async () => {
    if (!activePlanId || !cloneTargetId.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/tariff-plans/${encodeURIComponent(activePlanId)}/clone`, {
        targetPlanId: cloneTargetId.trim(),
        name: cloneName.trim() || undefined,
      });
      setIsCloneOpen(false);
      setActivePlanId(null);
      setCloneTargetId('');
      setCloneName('');
      setNotice({ type: 'success', message: `Tariff plan cloned to ${cloneTargetId}.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Clone failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 4. Enable Tariff Plan: POST /api/tariff-plans/{planId}/enable
  const handleEnable = async () => {
    if (!activePlanId) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/tariff-plans/${encodeURIComponent(activePlanId)}/enable`);
      setIsEnableOpen(false);
      setActivePlanId(null);
      setNotice({ type: 'success', message: `Tariff plan ${activePlanId} enabled.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Enable failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 5. Disable Tariff Plan: POST /api/tariff-plans/{planId}/disable
  const handleDisable = async () => {
    if (!activePlanId) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/tariff-plans/${encodeURIComponent(activePlanId)}/disable`);
      setIsDisableOpen(false);
      setActivePlanId(null);
      setNotice({ type: 'success', message: `Tariff plan ${activePlanId} disabled.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Disable failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 6. Delete Tariff Plan: DELETE /api/tariff-plans/{planId}
  const handleDelete = async () => {
    if (!activePlanId) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await deleteJson(`/api/tariff-plans/${encodeURIComponent(activePlanId)}`);
      setIsDeleteOpen(false);
      setActivePlanId(null);
      setNotice({ type: 'success', message: `Tariff plan ${activePlanId} deleted.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed Tariff Management</p>
          <h1>Tariff Plans</h1>
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
        <div />
        {canWrite && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setPlanIdInput('');
              setNameInput('');
              setDescInput('');
              setIsCreateOpen(true);
            }}
          >
            <Plus size={16} />
            Create Tariff Plan
          </button>
        )}
      </div>

      {tariffs.isLoading ? (
        <section className="read-state" role="status">{t('loading')}</section>
      ) : tariffs.error ? (
        <section className="read-state error" role="alert">
          <p>{tariffs.error.message}</p>
          <button type="button" onClick={() => void refreshData()}>{t('refresh')}</button>
        </section>
      ) : rows.length === 0 ? (
        <section className="read-state">{t('empty')}</section>
      ) : (
        <>
          <div className="read-table-wrap">
            <table className="read-table">
              <thead>
                <tr>
                  <th>Plan ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Subscribers</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const planId = text(row.plan_id);
                  const status = text(row.status).toLowerCase();
                  return (
                    <tr key={planId}>
                      <td data-label="Plan ID">{planId}</td>
                      <td data-label="Name">{text(row.name)}</td>
                      <td data-label="Status">
                        <span className={`badge badge-${status}`}>{text(row.status)}</span>
                      </td>
                      <td data-label="Version">{text(row.version)}</td>
                      <td data-label="Subscribers">{text(row.subscriber_count)}</td>
                      <td data-label="Updated">{text(row.updated_at)}</td>
                      <td data-label="Actions">
                        <div className="table-actions">
                          <Link to={`/ocs/tariffs/${encodeURIComponent(planId)}`} className="btn-secondary btn-sm">
                            {t('details')}
                          </Link>
                          {canWrite && (
                            <>
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                title="Edit"
                                onClick={() => {
                                  setActivePlanId(planId);
                                  setNameInput(text(row.name));
                                  setDescInput(text(row.description));
                                  setIsEditOpen(true);
                                }}
                              >
                                <Edit2 size={14} />
                              </button>
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                title="Clone"
                                onClick={() => {
                                  setActivePlanId(planId);
                                  setCloneTargetId(`${planId}_clone`);
                                  setCloneName(`${text(row.name)} Copy`);
                                  setIsCloneOpen(true);
                                }}
                              >
                                <Copy size={14} />
                              </button>
                              {status === 'disabled' ? (
                                <button
                                  type="button"
                                  className="btn-secondary btn-sm"
                                  title="Enable"
                                  onClick={() => {
                                    setActivePlanId(planId);
                                    setIsEnableOpen(true);
                                  }}
                                >
                                  <CheckCircle size={14} />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-secondary btn-sm"
                                  title="Disable"
                                  onClick={() => {
                                    setActivePlanId(planId);
                                    setIsDisableOpen(true);
                                  }}
                                >
                                  <XCircle size={14} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-danger btn-sm"
                                title="Delete"
                                onClick={() => {
                                  setActivePlanId(planId);
                                  setIsDeleteOpen(true);
                                }}
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
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

      {/* Modal 1: Create Plan */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Create Tariff Plan"
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
              {submitting ? 'Creating...' : 'Create Plan'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="create-plan-id">Plan ID *</label>
          <input
            id="create-plan-id"
            className="form-input"
            value={planIdInput}
            onChange={(e) => setPlanIdInput(e.target.value)}
            placeholder="e.g. standard_5g"
          />
        </div>
        <div className="form-group">
          <label htmlFor="create-plan-name">Name *</label>
          <input
            id="create-plan-name"
            className="form-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="Plan display name"
          />
        </div>
        <div className="form-group">
          <label htmlFor="create-plan-desc">Description</label>
          <input
            id="create-plan-desc"
            className="form-input"
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
            placeholder="Plan description"
          />
        </div>
      </Modal>

      {/* Modal 2: Edit Plan */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title={`Edit Tariff Plan: ${activePlanId}`}
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
              {submitting ? 'Saving...' : 'Save Plan'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="edit-plan-name">Name *</label>
          <input
            id="edit-plan-name"
            className="form-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="edit-plan-desc">Description</label>
          <input
            id="edit-plan-desc"
            className="form-input"
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
          />
        </div>
      </Modal>

      {/* Modal 3: Clone Plan */}
      <Modal
        isOpen={isCloneOpen}
        onClose={() => setIsCloneOpen(false)}
        title={`Clone Tariff Plan: ${activePlanId}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsCloneOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleClone()}
              disabled={submitting}
            >
              {submitting ? 'Cloning...' : 'Clone Plan'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="clone-target-id">New Plan ID *</label>
          <input
            id="clone-target-id"
            className="form-input"
            value={cloneTargetId}
            onChange={(e) => setCloneTargetId(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="clone-name">New Plan Name</label>
          <input
            id="clone-name"
            className="form-input"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
          />
        </div>
      </Modal>

      {/* Confirmation: Enable */}
      <ConfirmDialog
        isOpen={isEnableOpen}
        onClose={() => setIsEnableOpen(false)}
        onConfirm={() => void handleEnable()}
        title="Enable Tariff Plan"
        description={`Enable tariff plan ${activePlanId}? Subscribers will be able to use this plan.`}
        confirmLabel="Enable Plan"
        isLoading={submitting}
      />

      {/* Confirmation: Disable */}
      <ConfirmDialog
        isOpen={isDisableOpen}
        onClose={() => setIsDisableOpen(false)}
        onConfirm={() => void handleDisable()}
        title="Disable Tariff Plan"
        description={`Disable tariff plan ${activePlanId}? (Note: plans with active subscribers cannot be disabled).`}
        confirmLabel="Disable Plan"
        isLoading={submitting}
      />

      {/* Confirmation: Delete */}
      <ConfirmDialog
        isOpen={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title="Delete Tariff Plan"
        description={`Permanently delete tariff plan ${activePlanId}? This operation is irreversible.`}
        confirmLabel="Delete Plan"
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
