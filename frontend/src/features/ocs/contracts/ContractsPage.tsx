import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Edit2, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Modal } from '../../../components/Modal';
import { deleteJson, patchJson, postJson } from '../../../lib/api/mutation-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const rowsOf = (v: unknown): UnknownRecord[] => {
  const r = asRecord(v);
  return listOf(r.records ?? r.items ?? r.subscribers ?? r.data ?? v);
};
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
const numberValue = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

export function ContractsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const contracts = useRead<unknown>(
    `/api/ocs/subscribers?page=${page}&limit=20&imsi=${encodeURIComponent(query)}`,
  );
  const tariffs = useRead<unknown>('/api/tariff-plans?limit=100');
  const rows = rowsOf(contracts.data);
  const total = numberValue(
    asRecord(contracts.data).total ?? asRecord(asRecord(contracts.data).pagination).total ?? rows.length,
  );
  const tariffList = rowsOf(tariffs.data);

  const canManage = hasPermission(user, 'ocs.plan.assign');

  // Modals & Action states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isUpdateTariffOpen, setIsUpdateTariffOpen] = useState(false);
  const [isSuspendOpen, setIsSuspendOpen] = useState(false);
  const [isResumeOpen, setIsResumeOpen] = useState(false);
  const [isTerminateOpen, setIsTerminateOpen] = useState(false);
  const [activeImsi, setActiveImsi] = useState<string | null>(null);

  // Form states
  const [imsiInput, setImsiInput] = useState('');
  const [msisdnInput, setMsisdnInput] = useState('');
  const [planIdInput, setPlanIdInput] = useState('');
  const [statusInput, setStatusInput] = useState('active');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await contracts.mutate();
  };

  // 1. Create Contract: POST /api/ocs/subscribers
  const handleCreate = async () => {
    if (!imsiInput.trim() || !planIdInput.trim()) {
      setNotice({ type: 'error', message: 'IMSI and Tariff Plan ID are required.' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson('/api/ocs/subscribers', {
        imsi: imsiInput.trim(),
        msisdn: msisdnInput.trim() || undefined,
        plan_id: planIdInput.trim(),
        status: statusInput,
      });
      setIsCreateOpen(false);
      setImsiInput('');
      setMsisdnInput('');
      setPlanIdInput('');
      setNotice({ type: 'success', message: 'Contract created successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Create contract failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 2. Update Tariff: PATCH /api/ocs/subscribers/{imsi}
  const handleUpdateTariff = async () => {
    if (!activeImsi || !planIdInput.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await patchJson(`/api/ocs/subscribers/${encodeURIComponent(activeImsi)}`, {
        plan_id: planIdInput.trim(),
      });
      setIsUpdateTariffOpen(false);
      setActiveImsi(null);
      setNotice({ type: 'success', message: `Tariff plan updated for contract ${activeImsi}.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update tariff failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 3. Suspend Contract: POST /api/ocs/subscribers/{imsi}/suspend
  const handleSuspend = async () => {
    if (!activeImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/ocs/subscribers/${encodeURIComponent(activeImsi)}/suspend`);
      setIsSuspendOpen(false);
      setActiveImsi(null);
      setNotice({ type: 'success', message: `Contract ${activeImsi} suspended.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Suspend failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 4. Resume Contract: POST /api/ocs/subscribers/{imsi}/resume
  const handleResume = async () => {
    if (!activeImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/ocs/subscribers/${encodeURIComponent(activeImsi)}/resume`);
      setIsResumeOpen(false);
      setActiveImsi(null);
      setNotice({ type: 'success', message: `Contract ${activeImsi} resumed.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Resume failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 5. Terminate Contract: DELETE /api/ocs/subscribers/{imsi}
  const handleTerminate = async () => {
    if (!activeImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await deleteJson(`/api/ocs/subscribers/${encodeURIComponent(activeImsi)}`);
      setIsTerminateOpen(false);
      setActiveImsi(null);
      setNotice({ type: 'success', message: `Contract ${activeImsi} terminated.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Terminate failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed OCS Contract Management</p>
          <h1>Contracts</h1>
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
            placeholder="Filter by IMSI..."
          />
        </label>
        {canManage && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setImsiInput('');
              setMsisdnInput('');
              setPlanIdInput('');
              setStatusInput('active');
              setIsCreateOpen(true);
            }}
          >
            <Plus size={16} />
            Create Contract
          </button>
        )}
      </div>

      {contracts.isLoading ? (
        <section className="read-state" role="status">{t('loading')}</section>
      ) : contracts.error ? (
        <section className="read-state error" role="alert">
          <p>{contracts.error.message}</p>
          <button type="button" onClick={() => void refreshData()}>{t('refresh')}</button>
        </section>
      ) : rows.length === 0 ? (
        <section className="read-state">{t('empty')}</section>
      ) : (
        <>
          <p className="read-summary">{total} {t('records')}</p>
          <div className="read-table-wrap">
            <table className="read-table">
              <thead>
                <tr>
                  <th>IMSI</th>
                  <th>Plan ID</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const imsi = text(row.imsi);
                  const status = text(row.status).toLowerCase();
                  return (
                    <tr key={imsi}>
                      <td data-label="IMSI">{imsi}</td>
                      <td data-label="Plan ID">{text(row.plan_id)}</td>
                      <td data-label="Status">
                        <span className={`badge badge-${status}`}>{text(row.status)}</span>
                      </td>
                      <td data-label="Version">{text(row.version)}</td>
                      <td data-label="Updated">{text(row.updated_at)}</td>
                      <td data-label="Actions">
                        <div className="table-actions">
                          <Link to={`/ocs/contracts/${encodeURIComponent(imsi)}`} className="btn-secondary btn-sm">
                            {t('details')}
                          </Link>
                          {canManage && (
                            <>
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                title="Change Tariff"
                                onClick={() => {
                                  setActiveImsi(imsi);
                                  setPlanIdInput(text(row.plan_id));
                                  setIsUpdateTariffOpen(true);
                                }}
                              >
                                <Edit2 size={14} />
                              </button>
                              {status === 'active' && (
                                <button
                                  type="button"
                                  className="btn-secondary btn-sm"
                                  title="Suspend Contract"
                                  onClick={() => {
                                    setActiveImsi(imsi);
                                    setIsSuspendOpen(true);
                                  }}
                                >
                                  <Pause size={14} />
                                </button>
                              )}
                              {status === 'suspended' && (
                                <button
                                  type="button"
                                  className="btn-secondary btn-sm"
                                  title="Resume Contract"
                                  onClick={() => {
                                    setActiveImsi(imsi);
                                    setIsResumeOpen(true);
                                  }}
                                >
                                  <Play size={14} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-danger btn-sm"
                                title="Terminate Contract"
                                onClick={() => {
                                  setActiveImsi(imsi);
                                  setIsTerminateOpen(true);
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

      {/* Modal 1: Create Contract */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Create OCS Contract"
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
              {submitting ? 'Creating...' : 'Create Contract'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="contract-imsi">IMSI *</label>
          <input
            id="contract-imsi"
            className="form-input"
            value={imsiInput}
            onChange={(e) => setImsiInput(e.target.value)}
            placeholder="001010000000001"
          />
        </div>
        <div className="form-group">
          <label htmlFor="contract-msisdn">MSISDN</label>
          <input
            id="contract-msisdn"
            className="form-input"
            value={msisdnInput}
            onChange={(e) => setMsisdnInput(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="contract-plan">Tariff Plan ID *</label>
          <select
            id="contract-plan"
            className="form-select"
            value={planIdInput}
            onChange={(e) => setPlanIdInput(e.target.value)}
          >
            <option value="">Select tariff plan...</option>
            {tariffList.map((tp) => (
              <option key={text(tp.plan_id)} value={text(tp.plan_id)}>
                {text(tp.name)} ({text(tp.plan_id)})
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="contract-status">Initial Status</label>
          <select
            id="contract-status"
            className="form-select"
            value={statusInput}
            onChange={(e) => setStatusInput(e.target.value)}
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
      </Modal>

      {/* Modal 2: Update Tariff */}
      <Modal
        isOpen={isUpdateTariffOpen}
        onClose={() => setIsUpdateTariffOpen(false)}
        title={`Update Tariff: ${activeImsi}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsUpdateTariffOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleUpdateTariff()}
              disabled={submitting || !planIdInput}
            >
              {submitting ? 'Updating...' : 'Save Plan'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="update-tariff-plan">Tariff Plan ID *</label>
          <select
            id="update-tariff-plan"
            className="form-select"
            value={planIdInput}
            onChange={(e) => setPlanIdInput(e.target.value)}
          >
            <option value="">Select tariff plan...</option>
            {tariffList.map((tp) => (
              <option key={text(tp.plan_id)} value={text(tp.plan_id)}>
                {text(tp.name)} ({text(tp.plan_id)})
              </option>
            ))}
          </select>
        </div>
      </Modal>

      {/* Confirmation 1: Suspend */}
      <ConfirmDialog
        isOpen={isSuspendOpen}
        onClose={() => setIsSuspendOpen(false)}
        onConfirm={() => void handleSuspend()}
        title="Suspend Contract"
        description={`Are you sure you want to suspend contract ${activeImsi}? The subscriber will not be able to use chargeable services until resumed.`}
        confirmLabel="Suspend Contract"
        isDanger={false}
        isLoading={submitting}
      />

      {/* Confirmation 2: Resume */}
      <ConfirmDialog
        isOpen={isResumeOpen}
        onClose={() => setIsResumeOpen(false)}
        onConfirm={() => void handleResume()}
        title="Resume Contract"
        description={`Resume contract for ${activeImsi}? Service access will be re-enabled.`}
        confirmLabel="Resume Contract"
        isDanger={false}
        isLoading={submitting}
      />

      {/* Confirmation 3: Terminate */}
      <ConfirmDialog
        isOpen={isTerminateOpen}
        onClose={() => setIsTerminateOpen(false)}
        onConfirm={() => void handleTerminate()}
        title="Terminate Contract"
        description={`Are you sure you want to terminate contract ${activeImsi}? This operation is permanent.`}
        confirmLabel="Terminate Contract"
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
