/*
 * CSV / JSON subscriber import.
 *
 * The service has owned `POST /api/subscribers/import` all along, and the client
 * contract (parsing, normalisation, request building) existed too; only the entry
 * point was missing, so the empty state told operators to import a CSV file they
 * had no way to import.
 *
 * The import creates records only. Credential material is rejected by the client
 * contract before anything is sent, which is why the panel states it up front.
 */
import { useRef, useState } from 'react';
import { Download, Upload, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { postJson } from '../../../lib/api/mutation-client';
import { Dialog } from '../../../components/ui/Dialog';
import { OperationNotice } from '../../../components/ui/OperationFeedback';
import { generateCsvTemplate, generateJsonTemplate, parseImportContent, type NormalizedImportRecord, type ParsedImportFile } from '../../../lib/csv';
import {
  buildImportPrecheckRequest,
  buildImportRequest,
  validateAndNormalizeImportRecord,
  type ImportRecord,
} from '../mutation-contract';

type PrecheckResponse = {
  total?: number;
  existing?: number;
  newCount?: number;
  conflicts?: Array<{ imsi: string; exists?: unknown[] }>;
};

type ImportResponse = {
  result?: {
    requested?: number;
    imported?: number;
    skipped?: number;
    failed?: number;
    failedImsis?: string[];
  };
};

export function SubscriberImportModal({ isOpen, onClose, onImported }: {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedImportFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [precheck, setPrecheck] = useState<PrecheckResponse | null>(null);
  const [isPrechecking, setIsPrechecking] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<ImportResponse['result'] | null>(null);

  const reset = () => {
    setParsed(null);
    setFileName('');
    setError('');
    setPrecheck(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const close = () => {
    const imported = Boolean(result && (result.imported ?? 0) > 0);
    reset();
    onClose();
    if (imported) onImported();
  };

  const readFile = async (file: File) => {
    setError('');
    setPrecheck(null);
    setResult(null);
    try {
      const content = await file.text();
      const next = parseImportContent(content);
      setFileName(file.name);
      setParsed(next);
    } catch (failure) {
      setParsed(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const downloadTemplate = (kind: 'csv' | 'json') => {
    const content = kind === 'csv' ? generateCsvTemplate() : generateJsonTemplate();
    const blob = new Blob([content], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `subscriber-import-template.${kind}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const runPrecheck = async () => {
    if (!parsed || parsed.records.length === 0) return;
    setIsPrechecking(true);
    setError('');
    try {
      const response = await postJson<PrecheckResponse>(
        '/api/subscribers/import?mode=precheck',
        buildImportPrecheckRequest(parsed.records.map((record) => record.imsi)),
      );
      setPrecheck(response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setIsPrechecking(false);
    }
  };

  const runImport = async () => {
    if (!parsed || parsed.records.length === 0) return;
    setIsImporting(true);
    setError('');
    try {
      /* The parser keeps every column it saw, including credential columns that
       * the wire contract refuses. Only the importable fields cross the boundary,
       * and only when the row actually carries them. */
      const records: ImportRecord[] = parsed.records.map((record: NormalizedImportRecord) => {
        const present = (value: unknown) => (value === undefined || value === null || String(value).trim() === '' ? undefined : value);
        return validateAndNormalizeImportRecord({
          imsi: record.imsi,
          plan_id: present(record.plan_id),
          traffic_total: present(record.traffic_total),
          traffic_balance: present(record.traffic_balance),
          sms_total: present(record.sms_total),
          sms_balance: present(record.sms_balance),
          access_restriction_data: present(record.access_restriction_data),
        });
      });
      const response = await postJson<ImportResponse>(
        '/api/subscribers/import?mode=import',
        buildImportRequest(records),
      );
      setResult(response.result ?? { imported: 0 });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setIsImporting(false);
    }
  };

  if (!isOpen) return null;

  const validCount = parsed?.records.length ?? 0;
  const sampleErrors = (parsed?.errors ?? []).slice(0, 5);

  return (
    <Dialog
      open
      onClose={close}
      overlayClassName="modal-overlay"
      className="modal-content workflow-modal animate-modal-enter"
      labelledBy="subscriber-import-title"
    >
      <div className="workflow-header">
        <h2 id="subscriber-import-title" className="sub-modal-new-title">{t('sub_import_title')}</h2>
        <button type="button" className="btn-icon" onClick={close} aria-label={t('close')}><X size={22} /></button>
      </div>

      <div className="workflow-body">
        <div className="workflow-content">
          <div className="workflow-content-inner">
            <p className="text-muted">{t('sub_import_desc')}</p>

            {error && (
              <OperationNotice presentation="inline" tone="danger" title={t('error')} message={error} onClose={() => setError('')} />
            )}

            {!result && (
              <>
                <div className="page-action-buttons" style={{ marginTop: 'var(--space-3, 12px)' }}>
                  <label className="btn btn-outline" htmlFor="subscriber-import-file">
                    <Upload size={15} /> {t('sub_import_pick')}
                  </label>
                  <input
                    id="subscriber-import-file"
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void readFile(file);
                    }}
                  />
                  <button type="button" className="btn btn-outline" onClick={() => downloadTemplate('csv')}>
                    <Download size={15} /> {t('sub_import_template_csv')}
                  </button>
                  <button type="button" className="btn btn-outline" onClick={() => downloadTemplate('json')}>
                    <Download size={15} /> {t('sub_import_template_json')}
                  </button>
                </div>

                {parsed && (
                  <div className="dash-card" style={{ marginTop: 'var(--space-3, 12px)' }}>
                    <div className="dash-card-body">
                      <p className="form-label">{fileName}</p>
                      <p>
                        {t('sub_import_summary', {
                          total: parsed.totalRows,
                          valid: parsed.validRows,
                          invalid: parsed.invalidRows,
                          duplicates: parsed.duplicateCount,
                        })}
                      </p>
                      {sampleErrors.length > 0 && (
                        <ul className="text-muted">
                          {sampleErrors.map((detail) => (
                            <li key={`${detail.row}-${detail.field ?? ''}-${detail.reason}`}>
                              {t('sub_import_row_error', { row: detail.row, reason: detail.reason })}
                            </li>
                          ))}
                        </ul>
                      )}
                      {precheck && (
                        <p className="text-muted">
                          {t('sub_import_precheck', {
                            existing: precheck.existing ?? 0,
                            fresh: precheck.newCount ?? validCount,
                          })}
                        </p>
                      )}
                      {validCount === 0 && <p className="warning-text">{t('sub_import_no_valid')}</p>}
                    </div>
                  </div>
                )}
              </>
            )}

            {result && (
              <div className="dash-card" style={{ marginTop: 'var(--space-3, 12px)' }}>
                <div className="dash-card-body">
                  <p>
                    {t('sub_import_result', {
                      requested: result.requested ?? 0,
                      imported: result.imported ?? 0,
                      failed: result.failed ?? 0,
                    })}
                  </p>
                  {(result.failedImsis ?? []).length > 0 && (
                    <p className="warning-text">
                      {t('sub_import_failed_imsis', { items: (result.failedImsis ?? []).slice(0, 5).join(', ') })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="workflow-footer">
        <div className="sub-modal-footer-msg">{t('sub_import_footer')}</div>
        <div className="workflow-footer-actions">
          <button type="button" className="btn btn-outline" onClick={close}>{result ? t('close') : t('cancel')}</button>
          {!result && (
            <>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => { void runPrecheck(); }}
                disabled={!parsed || validCount === 0 || isPrechecking || isImporting}
              >
                {isPrechecking ? t('sub_import_checking') : t('sub_import_precheck_btn')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { void runImport(); }}
                disabled={!parsed || validCount === 0 || isImporting}
              >
                {isImporting ? t('sub_import_running') : t('sub_import_submit')}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
