import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, RefreshCw, Sliders, Wallet } from 'lucide-react';
import { Modal } from '../../../components/Modal';
import { postJson } from '../../../lib/api/mutation-client';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { EmptyState, ErrorState } from '../../../components/ui/StatePanel';
import { SkeletonTable } from '../../../components/ui/LoadingSkeleton';
import MetricStrip from '../../../components/ui/MetricStrip';
import PageHeader from '../../../components/ui/PageHeader';
import { formatBytes } from '../../../lib/unitParser';

type UnknownRecord = Record<string, unknown>;
const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const rowsOf = (v: unknown): UnknownRecord[] => {
  const r = asRecord(v);
  return listOf(r.records ?? r.items ?? r.balances ?? r.data ?? v);
};
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
const numberValue = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

export function BalancesPage() {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string; isConflict?: boolean } | null>(null);

  const balances = useRead<unknown>(
    `/api/ocs/balances?page=${page}&limit=20&imsi=${encodeURIComponent(query)}`,
  );
  const rows = rowsOf(balances.data);
  const total = numberValue(
    asRecord(balances.data).total ?? asRecord(asRecord(balances.data).pagination).total ?? rows.length,
  );

  const canAdjust = hasPermission(user, 'ocs.balance.adjust');

  // Adjustment modal state
  const [isAdjustOpen, setIsAdjustOpen] = useState(false);
  const [adjustImsi, setAdjustImsi] = useState('');
  const [adjustBucket, setAdjustBucket] = useState<'data' | 'voice' | 'sms'>('data');
  const [adjustOperation, setAdjustOperation] = useState<'credit' | 'debit'>('credit');
  const [adjustAmount, setAdjustAmount] = useState('100');
  const [adjustReason, setAdjustReason] = useState('Customer support balance top-up');
  const [adjustTicketId, setAdjustTicketId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleAdjust = async () => {
    const amountNum = Number(adjustAmount);
    if (!adjustImsi.trim() || !amountNum || amountNum <= 0) {
      setNotice({ type: 'error', message: 'Valid IMSI and positive amount are required.' });
      return;
    }
    if (!adjustReason.trim()) {
      setNotice({ type: 'error', message: 'Reason is required (max 200 characters).' });
      return;
    }

    setSubmitting(true);
    setNotice(null);
    try {
      await postJson(`/api/ocs/balances/${encodeURIComponent(adjustImsi.trim())}/adjust`, {
        operation: adjustOperation,
        bucket: adjustBucket,
        amount: amountNum,
        reason: adjustReason.trim(),
        ticketId: adjustTicketId.trim() || undefined,
      });
      setIsAdjustOpen(false);
      setNotice({ type: 'success', message: `Balance adjusted successfully for IMSI ${adjustImsi}.` });
      await balances.mutate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Balance adjustment failed';
      const isConflict = msg.includes('precondition') || msg.includes('conflict') || msg.includes('409');
      setNotice({ type: 'error', message: msg, isConflict });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('nav_ocs')}
        title={t('ocs_balances_title')}
        description={t('ocs_balances_desc')}
        actions={
          <button type="button" className="btn btn-secondary" onClick={() => void balances.mutate()}>
            <RefreshCw size={16} />
            {t('refresh')}
          </button>
        }
      />

      <MetricStrip
        variant="cards"
        columns={2}
        ariaLabel={t('ocs_balances_title')}
        items={[
          { key: 'total', label: t('ocs_balance_total_accounts'), value: total, icon: <Wallet size={20} /> },
          { key: 'active', label: t('ocs_balance_active_accounts'), value: rows.filter((row) => text(row.status).toLowerCase() === 'active').length, icon: <CheckCircle size={20} /> },
        ]}
      />

      {notice && (
        <div className={`notice-box ${notice.type}`} role="status">
          <span>{notice.message}</span>
          {notice.isConflict && (
            <button
              type="button"
              className="btn-secondary btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => void balances.mutate()}
            >
              Reload Balance Data
            </button>
          )}
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
        {canAdjust && (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setAdjustImsi('');
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

      {balances.isLoading ? (
        <SkeletonTable rows={6} />
      ) : balances.error ? (
        <ErrorState title={t('error_title')} message={balances.error.message} retryLabel={t('refresh')} onRetry={() => void balances.mutate()} />
      ) : rows.length === 0 ? (
        <EmptyState title={t('empty_title')} description={t('empty_generic_body')} />
      ) : (
        <>
          <p className="read-summary">{total} {t('records')}</p>
          <div className="read-table-wrap">
            <table className="read-table">
              <thead>
                <tr>
                  <th>IMSI</th>
                  <th>{t('ocs_col_data_available')}</th>
                  <th>{t('ocs_col_voice_avail')}</th>
                  <th>{t('ocs_col_sms_avail')}</th>
                  <th>{t('ocs_col_status')}</th>
                  <th>{t('ocs_col_version')}</th>
                  <th>{t('ocs_tariff_col_updated')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const imsi = text(row.imsi);
                  return (
                    <tr key={imsi}>
                      <td data-label="IMSI" className="ocs-mono">{imsi}</td>
                      <td data-label="Data Available" className="ocs-mono">{formatBytes(numberValue(row.data_available))}</td>
                      <td data-label="Voice Available" className="ocs-mono">{numberValue(row.voice_available)}s</td>
                      <td data-label="SMS Available" className="ocs-mono">{numberValue(row.sms_available)}</td>
                      <td data-label="Status">
                        <span className={`badge badge-${text(row.status).toLowerCase()}`}>{text(row.status)}</span>
                      </td>
                      <td data-label="Version" className="ocs-mono">v{numberValue(row.version) || 1}</td>
                      <td data-label="Updated" className="ocs-time-cell">
                        {row.updated_at ? formatDateTime(row.updated_at as string) : '—'}
                      </td>
                      <td data-label="Actions">
                        <div className="table-actions">
                          <Link to={`/ocs/balances/${encodeURIComponent(imsi)}`} className="btn-secondary btn-sm">
                            {t('details')}
                          </Link>
                          {canAdjust && (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              onClick={() => {
                                setAdjustImsi(imsi);
                                setIsAdjustOpen(true);
                              }}
                            >
                              Adjust
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

      {/* Balance Adjustment Modal */}
      <Modal
        isOpen={isAdjustOpen}
        onClose={() => setIsAdjustOpen(false)}
        title={`Adjust Balance ${adjustImsi ? `for ${adjustImsi}` : ''}`}
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
          <label htmlFor="bal-imsi">IMSI *</label>
          <input
            id="bal-imsi"
            className="form-input"
            value={adjustImsi}
            onChange={(e) => setAdjustImsi(e.target.value)}
            placeholder="001010000000001"
          />
        </div>
        <div className="form-group">
          <label htmlFor="bal-op">Operation *</label>
          <select
            id="bal-op"
            className="form-select"
            value={adjustOperation}
            onChange={(e) => setAdjustOperation(e.target.value as 'credit' | 'debit')}
          >
            <option value="credit">Credit (Add)</option>
            <option value="debit">Debit (Deduct)</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="bal-bucket">Bucket *</label>
          <select
            id="bal-bucket"
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
          <label htmlFor="bal-amount">Amount *</label>
          <input
            id="bal-amount"
            type="number"
            className="form-input"
            value={adjustAmount}
            onChange={(e) => setAdjustAmount(e.target.value)}
            min={1}
          />
        </div>
        <div className="form-group">
          <label htmlFor="bal-reason">Reason * (max 200 chars)</label>
          <input
            id="bal-reason"
            className="form-input"
            value={adjustReason}
            onChange={(e) => setAdjustReason(e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="form-group">
          <label htmlFor="bal-ticket">Ticket ID (Optional)</label>
          <input
            id="bal-ticket"
            className="form-input"
            value={adjustTicketId}
            onChange={(e) => setAdjustTicketId(e.target.value)}
            placeholder="e.g. INC-10294"
          />
        </div>
      </Modal>
    </div>
  );
}
