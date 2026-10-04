import { useState } from 'react';
import { Edit2, FileText, Plus, RefreshCw, Sliders, Trash2, Upload, Users } from 'lucide-react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { deleteJson, postJson, putJson } from '../../lib/api/mutation-client';
import { useRead } from '../../lib/api/use-read';
import { hasPermission } from '../../lib/permissions';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import {
  buildBatchCreateRequest,
  buildBatchPrecheckRequest,
  buildBatchUpdateRequest,
  buildBulkDeleteRequest,
  buildImportPrecheckRequest,
  buildImportRequest,
  buildProfileApplyRequest,
  buildSubscriberCreateRequest,
  buildSubscriberUpdateRequest,
  buildTrafficAdjustRequest,
  validateAndNormalizeImportRecord,
  type ImportRecord,
} from './mutation-contract';

type UnknownRecord = Record<string, unknown>;
type PlmnRecord = { mcc?: string; mnc?: string; country?: string; network?: string };

const asRecord = (v: unknown): UnknownRecord => (v && typeof v === 'object' && !Array.isArray(v) ? (v as UnknownRecord) : {});
const listOf = (v: unknown): UnknownRecord[] => (Array.isArray(v) ? v.map(asRecord) : []);
const rowsOf = (v: unknown): UnknownRecord[] => {
  const r = asRecord(v);
  return listOf(r.records ?? r.items ?? r.subscribers ?? r.data ?? v);
};
const text = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
const numberValue = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

function resolvePlmn(row: UnknownRecord, catalog: PlmnRecord[]): string {
  const explicit = typeof row.plmn === 'string' ? row.plmn : undefined;
  if (explicit) return explicit;
  const imsi = text(row.imsi);
  const mcc = text(row.mcc ?? imsi.slice(0, 3));
  const mnc = text(row.mnc ?? imsi.slice(3, 5));
  const match = catalog.find((entry) => entry.mcc === mcc && entry.mnc === mnc);
  return match ? `${match.country ?? mcc} / ${match.network ?? mnc}` : `${mcc}-${mnc}`;
}

export function SubscribersPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selectedImsis, setSelectedImsis] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Read data
  const subscribers = useRead<unknown>(
    `/api/subscribers?detail=true&page=${page}&limit=20&q=${encodeURIComponent(query)}`,
  );
  const catalog = useRead<PlmnRecord[]>('/data/mcc-mnc-table.json');
  const profiles = useRead<unknown>('/api/profiles');

  const rows: Record<string, unknown>[] = rowsOf(subscribers.data).map((row) => ({
    ...row,
    plmn: resolvePlmn(row, catalog.data ?? []),
  }));
  const total = numberValue(
    asRecord(subscribers.data).total ?? asRecord(asRecord(subscribers.data).pagination).total ?? rows.length,
  );
  const profileList = rowsOf(profiles.data);

  // Permission flags (presentation only)
  const canWrite = hasPermission(user, 'subscribers.write');
  const canDelete = hasPermission(user, 'subscribers.delete') || canWrite;
  const canAdjustTraffic = hasPermission(user, 'ocs.balance.adjust');

  // Modal states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isBatchCreateOpen, setIsBatchCreateOpen] = useState(false);
  const [isBatchUpdateOpen, setIsBatchUpdateOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isProfileApplyOpen, setIsProfileApplyOpen] = useState(false);
  const [isTrafficAdjustOpen, setIsTrafficAdjustOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
  const [activeImsi, setActiveImsi] = useState<string | null>(null);

  // Form states
  const [imsiInput, setImsiInput] = useState('');
  const [msisdnInput, setMsisdnInput] = useState('');
  const [originalMsisdn, setOriginalMsisdn] = useState<string | null>(null);
  const [planIdInput, setPlanIdInput] = useState('');
  const [profileInput, setProfileInput] = useState('');
  const [batchStartImsi, setBatchStartImsi] = useState('001010000000001');
  const [batchCount, setBatchCount] = useState(10);
  const [batchImsisText, setBatchImsisText] = useState('');
  const [batchReason, setBatchReason] = useState('Operational batch adjustment');
  const [batchAccessRestriction, setBatchAccessRestriction] = useState('32');
  const [batchTicketId, setBatchTicketId] = useState('');
  const [importJsonText, setImportJsonText] = useState('');
  const [importPrecheckResult, setImportPrecheckResult] = useState<string | null>(null);
  const [trafficBucket, setTrafficBucket] = useState<'data' | 'voice' | 'sms'>('data');
  const [trafficAmount, setTrafficAmount] = useState('100');
  const [trafficReason, setTrafficReason] = useState('Manual adjustment');
  const [submitting, setSubmitting] = useState(false);

  // Checkbox handling
  const toggleSelect = (imsi: string) => {
    setSelectedImsis((prev) => (prev.includes(imsi) ? prev.filter((i) => i !== imsi) : [...prev, imsi]));
  };
  const toggleSelectAll = () => {
    if (selectedImsis.length === rows.length) {
      setSelectedImsis([]);
    } else {
      setSelectedImsis(rows.map((r) => text(r['imsi'])).filter((i) => i !== '-'));
    }
  };

  const refreshData = async () => {
    await subscribers.mutate();
    setSelectedImsis([]);
  };

  // 1. Single Create: POST /api/subscribers
  const handleCreate = async () => {
    if (!imsiInput.trim()) {
      setNotice({ type: 'error', message: 'IMSI is required' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = buildSubscriberCreateRequest(imsiInput, {
        msisdn: msisdnInput.trim() || undefined,
        planId: planIdInput.trim() || undefined,
      });
      await postJson('/api/subscribers', payload);
      setIsCreateOpen(false);
      setImsiInput('');
      setMsisdnInput('');
      setPlanIdInput('');
      setNotice({ type: 'success', message: 'Subscriber created successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Create failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 2. Single Edit: PUT /api/subscribers/{imsi}
  const handleEdit = async () => {
    if (!activeImsi) return;
    const nextMsisdn = msisdnInput.trim();
    if (originalMsisdn !== null && nextMsisdn === originalMsisdn) {
      setNotice({ type: 'info', message: 'No changes detected.' });
      setIsEditOpen(false);
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = buildSubscriberUpdateRequest({
        msisdn: nextMsisdn,
      });
      await putJson(`/api/subscribers/${encodeURIComponent(activeImsi)}`, payload);
      setIsEditOpen(false);
      setActiveImsi(null);
      setOriginalMsisdn(null);
      setNotice({ type: 'success', message: 'Subscriber updated successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 3. Single Delete: DELETE /api/subscribers/{imsi}
  const handleDelete = async () => {
    if (!activeImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      await deleteJson(`/api/subscribers/${encodeURIComponent(activeImsi)}`);
      setIsDeleteOpen(false);
      setActiveImsi(null);
      setNotice({ type: 'success', message: 'Subscriber deleted successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 4. Batch Create: POST /api/subscribers/batch (and precheck)
  const handleBatchCreatePrecheck = async () => {
    setSubmitting(true);
    try {
      const payload = buildBatchPrecheckRequest(batchStartImsi, Number(batchCount) || 1);
      await postJson('/api/subscribers/batch/precheck', payload);
      setNotice({ type: 'info', message: 'Batch precheck passed successfully.' });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Precheck failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleBatchCreate = async () => {
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = buildBatchCreateRequest(batchStartImsi, Number(batchCount) || 1, {
        profileName: profileInput.trim() || undefined,
        planId: planIdInput.trim() || undefined,
        strategy: 'overwrite',
      });
      await postJson('/api/subscribers/batch', payload);
      setIsBatchCreateOpen(false);
      setNotice({ type: 'success', message: 'Batch create executed successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Batch create failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 5. Batch Update: POST /api/subscribers/batch-update
  const handleBatchUpdate = async () => {
    const imsis = batchImsisText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!imsis.length) {
      setNotice({ type: 'error', message: 'At least one IMSI is required' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const patch = { accessRestrictionData: Number(batchAccessRestriction) || 32 };
      const payload = buildBatchUpdateRequest(imsis, patch, batchReason, {
        ticketId: batchTicketId.trim() || undefined,
      });
      await postJson('/api/subscribers/batch-update', payload);
      setIsBatchUpdateOpen(false);
      setBatchImsisText('');
      setNotice({ type: 'success', message: 'Batch update executed successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Batch update failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 6. Bulk Delete: POST /api/subscribers/bulk-delete
  const handleBulkDelete = async () => {
    if (!selectedImsis.length) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = buildBulkDeleteRequest(selectedImsis);
      await postJson('/api/subscribers/bulk-delete', payload);
      setIsBulkDeleteOpen(false);
      setSelectedImsis([]);
      setNotice({ type: 'success', message: `Bulk delete executed for ${selectedImsis.length} subscribers.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Bulk delete failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 7. Import: POST /api/subscribers/import (mode=precheck then mode=import)
  const handleImportPrecheck = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importJsonText);
    } catch {
      setNotice({ type: 'error', message: 'Invalid JSON format in import data' });
      return;
    }
    setSubmitting(true);
    try {
      const raw = Array.isArray(parsed)
        ? parsed
        : (parsed as { records?: unknown[]; subscribers?: unknown[] })?.records ??
          (parsed as { records?: unknown[]; subscribers?: unknown[] })?.subscribers ??
          [];
      if (!raw.length) {
        setNotice({ type: 'error', message: 'No records found in import payload' });
        return;
      }
      const normalizedRecords: ImportRecord[] = [];
      const seenImsis = new Set<string>();
      for (const item of raw) {
        const record = validateAndNormalizeImportRecord(item);
        if (seenImsis.has(record.imsi)) {
          throw new Error(`Duplicate IMSI in import records: ${record.imsi}`);
        }
        seenImsis.add(record.imsi);
        normalizedRecords.push(record);
      }
      const imsiList = normalizedRecords.map((r) => r.imsi);
      const payload = buildImportPrecheckRequest(imsiList);
      const res = await postJson<{ validCount?: number; total?: number; conflicts?: unknown[] }>(
        '/api/subscribers/import?mode=precheck',
        payload,
      );
      setImportPrecheckResult(`Precheck passed: ${res.validCount ?? imsiList.length} valid entries ready for import.`);
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Import precheck failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleImportExecute = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importJsonText);
    } catch {
      setNotice({ type: 'error', message: 'Invalid JSON format in import data' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const raw = Array.isArray(parsed)
        ? parsed
        : (parsed as { records?: unknown[]; subscribers?: unknown[] })?.records ??
          (parsed as { records?: unknown[]; subscribers?: unknown[] })?.subscribers ??
          [];
      if (!raw.length) {
        setNotice({ type: 'error', message: 'No records to import' });
        return;
      }
      const records: ImportRecord[] = raw.map((item) => validateAndNormalizeImportRecord(item));
      const payload = buildImportRequest(records, false);
      await postJson('/api/subscribers/import?mode=import', payload);
      setIsImportOpen(false);
      setImportJsonText('');
      setImportPrecheckResult(null);
      setNotice({ type: 'success', message: 'Subscribers imported successfully.' });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Import failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 8. Profile Apply: POST /api/subscribers/{imsi}/profile
  const handleProfileApply = async () => {
    if (!activeImsi || !profileInput.trim()) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = buildProfileApplyRequest(profileInput.trim());
      await postJson(`/api/subscribers/${encodeURIComponent(activeImsi)}/profile`, payload);
      setIsProfileApplyOpen(false);
      setActiveImsi(null);
      setNotice({ type: 'success', message: `Profile applied to subscriber ${activeImsi}.` });
      await refreshData();
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Profile apply failed' });
    } finally {
      setSubmitting(false);
    }
  };

  // 9. Traffic Adjustment: POST /api/subscribers/{imsi}/traffic-adjustments
  const handleTrafficAdjust = async () => {
    if (!activeImsi) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = buildTrafficAdjustRequest({
        bucket: trafficBucket,
        amount: Number(trafficAmount) || 0,
        reason: trafficReason.trim(),
      });
      await postJson(`/api/subscribers/${encodeURIComponent(activeImsi)}/traffic-adjustments`, payload);
      setIsTrafficAdjustOpen(false);
      setNotice({
        type: 'info',
        message: 'Traffic adjustment request was accepted by the Go routing endpoint. No balance mutation is confirmed by this response.',
      });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Traffic adjust failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">Governed Subscriber Management</p>
          <h1>{t('nav_subscribers')}</h1>
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

      {/* Action Toolbar */}
      <div className="action-toolbar">
        <label className="read-search">
          {t('search')}
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search by IMSI..."
          />
        </label>

        <div className="toolbar-actions">
          {canWrite && (
            <>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setImsiInput('');
                  setMsisdnInput('');
                  setPlanIdInput('');
                  setIsCreateOpen(true);
                }}
              >
                <Plus size={16} />
                Create
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsBatchCreateOpen(true)}
              >
                <Users size={16} />
                Batch Create
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsBatchUpdateOpen(true)}
              >
                <Sliders size={16} />
                Batch Update
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setImportJsonText('');
                  setImportPrecheckResult(null);
                  setIsImportOpen(true);
                }}
              >
                <Upload size={16} />
                Import
              </button>
            </>
          )}

          {canDelete && selectedImsis.length > 0 && (
            <button
              type="button"
              className="btn-danger"
              onClick={() => setIsBulkDeleteOpen(true)}
            >
              <Trash2 size={16} />
              Delete Selected ({selectedImsis.length})
            </button>
          )}
        </div>
      </div>

      {/* Main Table */}
      {subscribers.isLoading || catalog.isLoading ? (
        <section className="read-state" role="status">
          {t('loading')}
        </section>
      ) : subscribers.error ? (
        <section className="read-state error" role="alert">
          <p>{subscribers.error.message}</p>
          <button type="button" onClick={() => void refreshData()}>
            {t('refresh')}
          </button>
        </section>
      ) : rows.length === 0 ? (
        <section className="read-state">{t('empty')}</section>
      ) : (
        <>
          <p className="read-summary">
            {total} {t('records')}
          </p>
          <div className="read-table-wrap">
            <table className="read-table">
              <thead>
                <tr>
                  {canDelete && (
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        checked={selectedImsis.length > 0 && selectedImsis.length === rows.length}
                        onChange={toggleSelectAll}
                        aria-label="Select all subscribers"
                      />
                    </th>
                  )}
                  <th>IMSI</th>
                  <th>Status</th>
                  <th>Traffic</th>
                  <th>Profile</th>
                  <th>PLMN</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const imsi = text(row['imsi']);
                  const isChecked = selectedImsis.includes(imsi);
                  return (
                    <tr key={imsi}>
                      {canDelete && (
                        <td className="checkbox-cell">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSelect(imsi)}
                            aria-label={`Select subscriber ${imsi}`}
                          />
                        </td>
                      )}
                      <td data-label="IMSI">{imsi}</td>
                      <td data-label="Status">
                        <span className={`badge badge-${text(row['status']).toLowerCase()}`}>
                          {text(row['status'])}
                        </span>
                      </td>
                      <td data-label="Traffic">{text(row['traffic'])}</td>
                      <td data-label="Profile">{text(row['profile'])}</td>
                      <td data-label="PLMN">{text(row['plmn'])}</td>
                      <td data-label="Actions">
                        <div className="table-actions">
                          {canWrite && (
                            <>
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                title="Edit subscriber"
                                onClick={() => {
                                  setActiveImsi(imsi);
                                  const rawMsisdn = Array.isArray(row['msisdn']) ? (row['msisdn'][0] ?? '') : (row['msisdn'] ?? '');
                                  const currentMsisdn = rawMsisdn === '-' ? '' : String(rawMsisdn).trim();
                                  setMsisdnInput(currentMsisdn);
                                  setOriginalMsisdn(currentMsisdn);
                                  setIsEditOpen(true);
                                }}
                              >
                                <Edit2 size={14} />
                              </button>
                              <button
                                type="button"
                                className="btn-secondary btn-sm"
                                title="Apply profile"
                                onClick={() => {
                                  setActiveImsi(imsi);
                                  setProfileInput(text(row['profile']));
                                  setIsProfileApplyOpen(true);
                                }}
                              >
                                <FileText size={14} />
                              </button>
                            </>
                          )}
                          {canAdjustTraffic && (
                            <button
                              type="button"
                              className="btn-secondary btn-sm"
                              title="Adjust traffic"
                              onClick={() => {
                                setActiveImsi(imsi);
                                setIsTrafficAdjustOpen(true);
                              }}
                            >
                              <Sliders size={14} />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              className="btn-danger btn-sm"
                              title="Delete subscriber"
                              onClick={() => {
                                setActiveImsi(imsi);
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

          <nav className="read-pagination">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage((v) => v - 1)}
            >
              {t('previous')}
            </button>
            <span>{page}</span>
            <button
              type="button"
              disabled={rows.length < 20}
              onClick={() => setPage((v) => v + 1)}
            >
              {t('next')}
            </button>
          </nav>
        </>
      )}

      {/* Modal 1: Single Create */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Create Subscriber"
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
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="create-imsi">IMSI (15 digits) *</label>
          <input
            id="create-imsi"
            className="form-input"
            value={imsiInput}
            onChange={(e) => setImsiInput(e.target.value)}
            maxLength={15}
            placeholder="e.g. 001010000000001"
          />
        </div>
        <div className="form-group">
          <label htmlFor="create-msisdn">MSISDN</label>
          <input
            id="create-msisdn"
            className="form-input"
            value={msisdnInput}
            onChange={(e) => setMsisdnInput(e.target.value)}
            placeholder="Optional telephone number"
          />
        </div>
        <div className="form-group">
          <label htmlFor="create-plan">Tariff Plan ID</label>
          <input
            id="create-plan"
            className="form-input"
            value={planIdInput}
            onChange={(e) => setPlanIdInput(e.target.value)}
            placeholder="Optional plan ID"
          />
        </div>
      </Modal>

      {/* Modal 2: Single Edit */}
      <Modal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        title={`Edit Subscriber: ${activeImsi}`}
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
          <label htmlFor="edit-msisdn">MSISDN</label>
          <input
            id="edit-msisdn"
            className="form-input"
            value={msisdnInput}
            onChange={(e) => setMsisdnInput(e.target.value)}
          />
        </div>
      </Modal>

      {/* Modal 3: Batch Create */}
      <Modal
        isOpen={isBatchCreateOpen}
        onClose={() => setIsBatchCreateOpen(false)}
        title="Batch Create Subscribers"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsBatchCreateOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleBatchCreatePrecheck()}
              disabled={submitting}
            >
              Precheck
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleBatchCreate()}
              disabled={submitting}
            >
              {submitting ? 'Executing...' : 'Execute Batch'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="batch-start-imsi">Start IMSI (15 digits) *</label>
          <input
            id="batch-start-imsi"
            className="form-input"
            value={batchStartImsi}
            onChange={(e) => setBatchStartImsi(e.target.value)}
            maxLength={15}
            placeholder="001010000000001"
          />
        </div>
        <div className="form-group">
          <label htmlFor="batch-count">Count *</label>
          <input
            id="batch-count"
            type="number"
            className="form-input"
            value={batchCount}
            onChange={(e) => setBatchCount(Number(e.target.value))}
            min={1}
            max={100}
          />
        </div>
        <div className="form-group">
          <label htmlFor="batch-profile">Profile Name</label>
          <select
            id="batch-profile"
            className="form-select"
            value={profileInput}
            onChange={(e) => setProfileInput(e.target.value)}
          >
            <option value="">Default Profile</option>
            {profileList.map((p) => (
              <option key={text(p.name)} value={text(p.name)}>
                {text(p.name)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="batch-plan">Tariff Plan ID</label>
          <input
            id="batch-plan"
            className="form-input"
            value={planIdInput}
            onChange={(e) => setPlanIdInput(e.target.value)}
            placeholder="Optional plan ID"
          />
        </div>
      </Modal>

      {/* Modal 4: Batch Update */}
      <Modal
        isOpen={isBatchUpdateOpen}
        onClose={() => setIsBatchUpdateOpen(false)}
        title="Batch Update Subscribers"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsBatchUpdateOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleBatchUpdate()}
              disabled={submitting}
            >
              {submitting ? 'Updating...' : 'Update Subscribers'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="batch-imsis">IMSIs (comma or line separated) *</label>
          <textarea
            id="batch-imsis"
            className="form-textarea"
            value={batchImsisText}
            onChange={(e) => setBatchImsisText(e.target.value)}
            placeholder="001010000000001, 001010000000002"
          />
        </div>
        <div className="form-group">
          <label htmlFor="batch-access-restriction">Access Restriction</label>
          <select
            id="batch-access-restriction"
            className="form-select"
            value={batchAccessRestriction}
            onChange={(e) => setBatchAccessRestriction(e.target.value)}
          >
            <option value="32">Normal Access (32)</option>
            <option value="255">Restricted Access (255)</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="batch-reason">Reason * (minimum 3 characters)</label>
          <input
            id="batch-reason"
            className="form-input"
            value={batchReason}
            onChange={(e) => setBatchReason(e.target.value)}
            placeholder="Operational batch adjustment"
          />
        </div>
        <div className="form-group">
          <label htmlFor="batch-ticket-id">Ticket ID (optional)</label>
          <input
            id="batch-ticket-id"
            className="form-input"
            value={batchTicketId}
            onChange={(e) => setBatchTicketId(e.target.value)}
            placeholder="CHG-20261004-001"
          />
        </div>
      </Modal>

      {/* Modal 5: Import */}
      <Modal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        title="Import Subscribers"
        maxWidth="38rem"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsImportOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleImportPrecheck()}
              disabled={submitting}
            >
              Validate / Precheck
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleImportExecute()}
              disabled={submitting || !importPrecheckResult}
            >
              {submitting ? 'Importing...' : 'Execute Import'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="import-data">Subscriber JSON Array</label>
          <textarea
            id="import-data"
            className="form-textarea"
            style={{ minHeight: '8rem', fontFamily: 'monospace' }}
            value={importJsonText}
            onChange={(e) => {
              setImportJsonText(e.target.value);
              setImportPrecheckResult(null);
            }}
            placeholder='[{"imsi": "001010000000001", "plan_id": "plan_default_10gb", "traffic_total": 10737418240, "traffic_balance": 10737418240, "sms_total": 100, "sms_balance": 100}]'
          />
        </div>
        <p style={{ fontSize: '.8rem', color: '#666', marginTop: '.25rem' }}>
          Server import policy creates new subscribers; overwrite is unsupported.
        </p>
        {importPrecheckResult && (
          <div className="notice-box info">
            <span>{importPrecheckResult}</span>
          </div>
        )}
      </Modal>

      {/* Modal 6: Profile Apply */}
      <Modal
        isOpen={isProfileApplyOpen}
        onClose={() => setIsProfileApplyOpen(false)}
        title={`Apply Profile to: ${activeImsi}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsProfileApplyOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleProfileApply()}
              disabled={submitting || !profileInput}
            >
              {submitting ? 'Applying...' : 'Apply Profile'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="apply-profile-select">Select Profile</label>
          <select
            id="apply-profile-select"
            className="form-select"
            value={profileInput}
            onChange={(e) => setProfileInput(e.target.value)}
          >
            <option value="">Select profile...</option>
            {profileList.map((p) => (
              <option key={text(p.name)} value={text(p.name)}>
                {text(p.name)}
              </option>
            ))}
          </select>
        </div>
      </Modal>

      {/* Modal 7: Traffic Adjustment */}
      <Modal
        isOpen={isTrafficAdjustOpen}
        onClose={() => setIsTrafficAdjustOpen(false)}
        title={`Adjust Traffic for: ${activeImsi}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIsTrafficAdjustOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleTrafficAdjust()}
              disabled={submitting}
            >
              {submitting ? 'Adjusting...' : 'Confirm Adjustment'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label htmlFor="traffic-bucket">Bucket</label>
          <select
            id="traffic-bucket"
            className="form-select"
            value={trafficBucket}
            onChange={(e) => setTrafficBucket(e.target.value as 'data' | 'voice' | 'sms')}
          >
            <option value="data">Data</option>
            <option value="voice">Voice</option>
            <option value="sms">SMS</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="traffic-amount">Amount</label>
          <input
            id="traffic-amount"
            type="number"
            className="form-input"
            value={trafficAmount}
            onChange={(e) => setTrafficAmount(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label htmlFor="traffic-reason">Reason</label>
          <input
            id="traffic-reason"
            className="form-input"
            value={trafficReason}
            onChange={(e) => setTrafficReason(e.target.value)}
          />
        </div>
      </Modal>

      {/* Confirmation 1: Single Delete */}
      <ConfirmDialog
        isOpen={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title="Delete Subscriber"
        description={`Are you sure you want to delete subscriber ${activeImsi}? This operation is irreversible.`}
        confirmLabel="Delete Subscriber"
        isDanger={true}
        isLoading={submitting}
      />

      {/* Confirmation 2: Bulk Delete */}
      <ConfirmDialog
        isOpen={isBulkDeleteOpen}
        onClose={() => setIsBulkDeleteOpen(false)}
        onConfirm={() => void handleBulkDelete()}
        title="Delete Multiple Subscribers"
        description={`Are you sure you want to delete ${selectedImsis.length} selected subscribers? This operation is irreversible.`}
        confirmLabel={`Delete ${selectedImsis.length} Subscribers`}
        isDanger={true}
        isLoading={submitting}
      />
    </section>
  );
}
