import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Edit2, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Modal } from '../../../components/Modal';
import { deleteJson, patchJson, postJson } from '../../../lib/api/mutation-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { EmptyState, ErrorState } from '../../../components/ui/StatePanel';
import { SkeletonTable } from '../../../components/ui/LoadingSkeleton';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));

export function ContractDetailPage() {
  const { imsi } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const encodedImsi = imsi ? encodeURIComponent(imsi) : null;
  const contract = useRead<unknown>(
    encodedImsi ? `/api/ocs/subscribers?imsi=${encodedImsi}&limit=1` : null,
  );
  const tariffs = useRead<unknown>('/api/tariff-plans?limit=100');

  const raw = asRecord(contract.data);
  const items = listOf(raw.items ?? raw.records ?? raw.subscribers ?? raw.data);
  const record = items[0] ?? raw;
  const entries = Object.entries(record).filter(([k]) => typeof record[k] !== 'object');
  const tariffList = listOf(asRecord(tariffs.data).items ?? asRecord(tariffs.data).plans ?? tariffs.data);

  const canManage = hasPermission(user, 'ocs.plan.assign');
  const status = text(record.status).toLowerCase();

  // Modals
  const [isUpdateTariffOpen, setIsUpdateTariffOpen] = useState(false);
  const [isSuspendOpen, setIsSuspendOpen] = useState(false);
  const [isResumeOpen, setIsResumeOpen] = useState(false);
  const [isTerminateOpen, setIsTerminateOpen] = useState(false);
  const [planIdInput, setPlanIdInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshData = async () => {
    await contract.mutate();
  };

  const handleUpdateTariff = async () => {
    if (!encodedImsi || !planIdInput.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await patchJson(`/api/ocs/subscribers/${encodedImsi}`, {
        plan_id: planIdInput.trim(),
      });
      setIsUpdateTariffOpen(false);
      setNotice({ type: 'success', message: 'Tariff plan updated successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSuspend = async () => {
    if (!encodedImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/ocs/subscribers/${encodedImsi}/suspend`);
      setIsSuspendOpen(false);
      setNotice({ type: 'success', message: 'Contract suspended successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Suspend failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleResume = async () => {
    if (!encodedImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/ocs/subscribers/${encodedImsi}/resume`);
      setIsResumeOpen(false);
      setNotice({ type: 'success', message: 'Contract resumed successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Resume failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleTerminate = async () => {
    if (!encodedImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await deleteJson(`/api/ocs/subscribers/${encodedImsi}`);
      setIsTerminateOpen(false);
      navigate('/ocs/contracts');
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Terminate failed' });
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed OCS Contract Management</p>
          <h1>Contract: {imsi}</h1>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button type="button" className="read-refresh" onClick={() => void refreshData()}>
            <RefreshCw size={16} />
            {t('refresh')}
          </button>
          {canManage && (
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setPlanIdInput(text(record.plan_id));
                  setIsUpdateTariffOpen(true);
                }}
              >
                <Edit2 size={16} />
                Change Tariff
              </button>
              {status === 'active' && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsSuspendOpen(true)}
                >
                  <Pause size={16} />
                  Suspend
                </button>
              )}
              {status === 'suspended' && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsResumeOpen(true)}
                >
                  <Play size={16} />
                  Resume
                </button>
              )}
              <button
                type="button"
                className="btn-danger"
                onClick={() => setIsTerminateOpen(true)}
              >
                <Trash2 size={16} />
                Terminate
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

      <button type="button" className="read-back" onClick={() => navigate('/ocs/contracts')}>
        {t('back')}
      </button>

      {contract.isLoading ? (
        <SkeletonTable rows={6} />
      ) : contract.error ? (
        <ErrorState title={t('error_title')} message={contract.error.message} retryLabel={t('refresh')} onRetry={() => void refreshData()} />
      ) : entries.length === 0 ? (
        <EmptyState title={t('empty_title')} description={t('empty_generic_body')} />
      ) : (
        <dl className="read-detail">
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll('_', ' ')}</dt>
              <dd>{text(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Modal: Update Tariff */}
      <Modal
        isOpen={isUpdateTariffOpen}
        onClose={() => setIsUpdateTariffOpen(false)}
        title={`Change Tariff for: ${imsi}`}
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
          <label htmlFor="detail-contract-plan">Tariff Plan *</label>
          <select
            id="detail-contract-plan"
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
        description={`Are you sure you want to suspend contract ${imsi}?`}
        confirmLabel="Suspend Contract"
        isLoading={submitting}
      />

      {/* Confirmation 2: Resume */}
      <ConfirmDialog
        isOpen={isResumeOpen}
        onClose={() => setIsResumeOpen(false)}
        onConfirm={() => void handleResume()}
        title="Resume Contract"
        description={`Resume contract for ${imsi}?`}
        confirmLabel="Resume Contract"
        isLoading={submitting}
      />

      {/* Confirmation 3: Terminate */}
      <ConfirmDialog
        isOpen={isTerminateOpen}
        onClose={() => setIsTerminateOpen(false)}
        onConfirm={() => void handleTerminate()}
        title="Terminate Contract"
        description={`Permanently terminate contract for ${imsi}?`}
        confirmLabel="Terminate Contract"
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
