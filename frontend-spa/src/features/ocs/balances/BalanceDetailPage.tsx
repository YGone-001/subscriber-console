import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RefreshCw, Sliders } from 'lucide-react';
import { Modal } from '../../../components/Modal';
import { postJson } from '../../../lib/api/mutation-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));

export function BalanceDetailPage() {
  const { imsi } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string; isConflict?: boolean } | null>(null);

  const encodedImsi = imsi ? encodeURIComponent(imsi) : null;
  const balance = useRead<unknown>(encodedImsi ? `/api/ocs/balances/${encodedImsi}` : null);
  const record = asRecord(balance.data);
  const entries = Object.entries(record).filter(([k]) => typeof record[k] !== 'object');

  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  // Adjustment modal state
  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  const [adjustBucket, setAdjustBucket] = useState<'data' | 'voice' | 'sms'>('data');
  const [adjustOperation, setAdjustOperation] = useState<'credit' | 'debit'>('credit');
  const [adjustAmount, setAdjustAmount] = useState('100');
  const [adjustReason, setAdjustReason] = useState('Customer support balance top-up');
  const [adjustTicketId, setAdjustTicketId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleAdjust = async () => {
    if (!encodedImsi) return;
    const amountNum = Number(adjustAmount);
    if (!amountNum || amountNum <= 0) {
      setNotice({ type: 'error', message: 'Positive amount is required.' });
      return;
    }
    if (!adjustReason.trim()) {
      setNotice({ type: 'error', message: 'Reason is required (max 200 characters).' });
      return;
    }

    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/ocs/balances/${encodedImsi}/adjust`, {
        operation: adjustOperation,
        bucket: adjustBucket,
        amount: amountNum,
        reason: adjustReason.trim(),
        ticketId: adjustTicketId.trim() || undefined,
      });
      setIsAdjustOpen(false);
      setNotice({ type: 'success', message: 'Balance adjusted successfully.' });
      await balance.mutate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Adjustment failed';
      const isConflict = msg.includes('precondition') || msg.includes('conflict') || msg.includes('409');
      setNotice({ type: 'error', message: msg, isConflict });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed OCS Balance Management</p>
          <h1>Balance: {imsi}</h1>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button type="button" className="read-refresh" onClick={() => void balance.mutate()}>
            <RefreshCw size={16} />
            {t('refresh')}
          </button>
          {canAdjust && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setAdjustAmount('100');
                setAdjustTicketId('');
                setIsAdjustOpen(true);
              }}
            >
              <Sliders size={16} />
              Adjust Balance
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice-box ${notice.type}`} role="status">
          <span>{notice.message}</span>
          {notice.isConflict && (
            <button
              type="button"
              className="btn-secondary btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => void balance.mutate()}
            >
              Reload Balance Data
            </button>
          )}
        </div>
      )}

      <button type="button" className="read-back" onClick={() => navigate('/ocs/balances')}>
        {t('back')}
      </button>

      {balance.isLoading ? (
        <section className="read-state" role="status">{t('loading')}</section>
      ) : balance.error ? (
        <section className="read-state error" role="alert">
          <p>{balance.error.message}</p>
          <button type="button" onClick={() => void balance.mutate()}>{t('refresh')}</button>
        </section>
      ) : entries.length === 0 ? (
        <section className="read-state">{t('empty')}</section>
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

      {/* Balance Adjustment Modal */}
      <Modal
        isOpen={isAdjustOpen}
        onClose={() => setIsAdjustOpen(false)}
        title={`Adjust Balance for: ${imsi}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsAdjustOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleAdjust()}
              disabled={submitting}
            >
              {submitting ? 'Applying Adjustment...' : 'Apply Adjustment'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="detail-bal-op">Operation *</label>
          <select
            id="detail-bal-op"
            className="form-select"
            value={adjustOperation}
            onChange={(e) => setAdjustOperation(e.target.value as 'credit' | 'debit')}
          >
            <option value="credit">Credit (Add)</option>
            <option value="debit">Debit (Deduct)</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="detail-bal-bucket">Bucket *</label>
          <select
            id="detail-bal-bucket"
            className="form-select"
            value={adjustBucket}
            onChange={(e) => setAdjustBucket(e.target.value as 'data' | 'voice' | 'sms')}
          >
            <option value="data">Data</option>
            <option value="voice">Voice</option>
            <option value="sms">SMS</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="detail-bal-amount">Amount *</label>
          <input
            id="detail-bal-amount"
            type="number"
            className="form-input"
            value={adjustAmount}
            onChange={(e) => setAdjustAmount(e.target.value)}
            min={1}
          />
        </div>
        <div className="form-group">
          <label htmlFor="detail-bal-reason">Reason * (max 200 chars)</label>
          <input
            id="detail-bal-reason"
            className="form-input"
            value={adjustReason}
            onChange={(e) => setAdjustReason(e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="form-group">
          <label htmlFor="detail-bal-ticket">Ticket ID (Optional)</label>
          <input
            id="detail-bal-ticket"
            className="form-input"
            value={adjustTicketId}
            onChange={(e) => setAdjustTicketId(e.target.value)}
            placeholder="e.g. INC-10294"
          />
        </div>
      </Modal>
    </section>
  );
}
