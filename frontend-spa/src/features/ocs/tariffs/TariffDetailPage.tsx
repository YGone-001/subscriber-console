import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle, Copy, Download, Edit2, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Modal } from '../../../components/Modal';
import { deleteJson, postJson, putJson } from '../../../lib/api/mutation-client';
import { getBlob } from '../../../lib/api/read-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));

export function TariffDetailPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const encoded = planId ? encodeURIComponent(planId) : null;
  const plan = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}` : null);
  const rules = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}/rules` : null);
  const subscribers = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}/subscribers` : null);
  const operations = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}/operations` : null);

  const record = asRecord(plan.data);
  const canWrite = hasPermission(user, 'ocs.tariff.write');
  const status = text(record.status).toLowerCase();

  // Modals & Action states
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isCloneOpen, setIsCloneOpen] = useState(false);
  const [isEnableOpen, setIsEnableOpen] = useState(false);
  const [isDisableOpen, setIsDisableOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const [nameInput, setNameInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [cloneTargetId, setCloneTargetId] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await plan.mutate();
    await rules.mutate();
    await subscribers.mutate();
    await operations.mutate();
  };

  const handleEdit = async () => {
    if (!encoded || !nameInput.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await putJson(`/api/tariff-plans/${encoded}`, {
        name: nameInput.trim(),
        description: descInput.trim() || undefined,
      });
      setIsEditOpen(false);
      setNotice({ type: 'success', message: 'Tariff plan updated successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClone = async () => {
    if (!encoded || !cloneTargetId.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/tariff-plans/${encoded}/clone`, {
        targetPlanId: cloneTargetId.trim(),
        name: cloneName.trim() || undefined,
      });
      setIsCloneOpen(false);
      setNotice({ type: 'success', message: `Tariff plan cloned to ${cloneTargetId}.` });
      navigate(`/ocs/tariffs/${encodeURIComponent(cloneTargetId.trim())}`);
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Clone failed' });
      setSubmitting(false);
    }
  };

  const handleEnable = async () => {
    if (!encoded) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/tariff-plans/${encoded}/enable`);
      setIsEnableOpen(false);
      setNotice({ type: 'success', message: 'Tariff plan enabled.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Enable failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisable = async () => {
    if (!encoded) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/tariff-plans/${encoded}/disable`);
      setIsDisableOpen(false);
      setNotice({ type: 'success', message: 'Tariff plan disabled.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Disable failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!encoded) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await deleteJson(`/api/tariff-plans/${encoded}`);
      setIsDeleteOpen(false);
      navigate('/ocs/tariffs');
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Delete failed' });
      setSubmitting(false);
    }
  };

  async function download() {
    if (!encoded) return;
    try {
      const blob = await getBlob(`/api/tariff-plans/${encoded}/export`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `tariff-plan-${planId}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    }
  }

  const entries = Object.entries(record).filter(([, v]) => typeof v !== 'object');
  const ruleRows = listOf(asRecord(rules.data).rules ?? rules.data);
  const subRows = listOf(asRecord(subscribers.data).subscribers ?? subscribers.data);
  const opRows = listOf(asRecord(operations.data).operations ?? operations.data);

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed Tariff Management</p>
          <h1>Tariff: {planId}</h1>
        </div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="read-refresh" onClick={() => void refreshData()}>
            <RefreshCw size={16} />
            {t('refresh')}
          </button>
          <button type="button" className="read-refresh" onClick={() => void download()}>
            <Download size={16} />
            {t('export')}
          </button>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setNameInput(text(record.name));
                  setDescInput(text(record.description));
                  setIsEditOpen(true);
                }}
              >
                <Edit2 size={16} />
                Edit
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setCloneTargetId(`${planId}_copy`);
                  setCloneName(`${text(record.name)} Copy`);
                  setIsCloneOpen(true);
                }}
              >
                <Copy size={16} />
                Clone
              </button>
              {status === 'disabled' ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsEnableOpen(true)}
                >
                  <CheckCircle size={16} />
                  Enable
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsDisableOpen(true)}
                >
                  <XCircle size={16} />
                  Disable
                </button>
              )}
              <button
                type="button"
                className="btn-danger"
                onClick={() => setIsDeleteOpen(true)}
              >
                <Trash2 size={16} />
                Delete
              </button>
            </>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice-box ${notice.type}`} role="status">
          <span>{notice.message}</span>
        </div>
      )}

      <button type="button" className="read-back" onClick={() => navigate('/ocs/tariffs')}>
        {t('back')}
      </button>

      {plan.isLoading ? (
        <section className="read-state" role="status">{t('loading')}</section>
      ) : plan.error ? (
        <section className="read-state error" role="alert">
          <p>{plan.error.message}</p>
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

          {ruleRows.length > 0 && (
            <section className="read-collection">
              <h2>Rules</h2>
              <div className="read-table-wrap">
                <table className="read-table">
                  <thead>
                    <tr>
                      {Object.keys(ruleRows[0]).slice(0, 5).map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ruleRows.map((row, idx) => (
                      <tr key={idx}>
                        {Object.keys(ruleRows[0]).slice(0, 5).map((col) => (
                          <td key={col} data-label={col}>{text(row[col])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {subRows.length > 0 && (
            <section className="read-collection">
              <h2>Subscribers ({subRows.length})</h2>
              <div className="read-table-wrap">
                <table className="read-table">
                  <thead>
                    <tr>
                      <th>IMSI</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subRows.map((row, idx) => (
                      <tr key={idx}>
                        <td data-label="IMSI">{text(row.imsi)}</td>
                        <td data-label="Status">{text(row.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {opRows.length > 0 && (
            <section className="read-collection">
              <h2>Operation History</h2>
              <div className="read-table-wrap">
                <table className="read-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opRows.map((row, idx) => (
                      <tr key={idx}>
                        <td data-label="Action">{text(row.action)}</td>
                        <td data-label="Actor">{text(row.actor)}</td>
                        <td data-label="Time">{text(row.timestamp ?? row.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* Modal: Edit Plan */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title={`Edit Tariff Plan: ${planId}`}
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
          <label htmlFor="detail-edit-name">Name *</label>
          <input
            id="detail-edit-name"
            className="form-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="detail-edit-desc">Description</label>
          <input
            id="detail-edit-desc"
            className="form-input"
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
          />
        </div>
      </Modal>

      {/* Modal: Clone Plan */}
      <Modal
        isOpen={isCloneOpen}
        onClose={() => setIsCloneOpen(false)}
        title={`Clone Tariff Plan: ${planId}`}
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
          <label htmlFor="detail-clone-id">Target Plan ID *</label>
          <input
            id="detail-clone-id"
            className="form-input"
            value={cloneTargetId}
            onChange={(e) => setCloneTargetId(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="detail-clone-name">New Plan Name</label>
          <input
            id="detail-clone-name"
            className="form-input"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
          />
        </div>
      </Modal>

      {/* Confirmations */}
      <ConfirmDialog
        isOpen={isEnableOpen}
        onClose={() => setIsEnableOpen(false)}
        onConfirm={() => void handleEnable()}
        title="Enable Tariff Plan"
        description={`Enable tariff plan ${planId}?`}
        confirmLabel="Enable Plan"
        isLoading={submitting}
      />
      <ConfirmDialog
        isOpen={isDisableOpen}
        onClose={() => setIsDisableOpen(false)}
        onConfirm={() => void handleDisable()}
        title="Disable Tariff Plan"
        description={`Disable tariff plan ${planId}? Plans with active subscribers cannot be disabled.`}
        confirmLabel="Disable Plan"
        isLoading={submitting}
      />
      <ConfirmDialog
        isOpen={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title="Delete Tariff Plan"
        description={`Permanently delete tariff plan ${planId}? This operation is irreversible.`}
        confirmLabel="Delete Plan"
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
