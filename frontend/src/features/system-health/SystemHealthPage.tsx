import { useCallback, useMemo, useState } from 'react';
import {
  Activity,
  Clock,
  Database,
  Layers,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  Zap,
} from 'lucide-react';
import { useAuth } from '../../providers/AuthProvider';
import { useRead } from '../../lib/api/use-read';
import { postJson, extractErrorMessage } from '../../lib/api/mutation-client';
import { useI18n } from '../../providers/I18nProvider';
import SectionHeader from '../../components/ui/SectionHeader';
import SubsystemCard from '../../components/health/SubsystemCard';
import {
  buildAnalyticsInitRequest,
  buildAuditScanRequest,
  buildSingleHealRequest,
  buildBatchHealRequest,
} from './operational-contract';
import type {
  AnalyticsInitResponse,
  AuditScanResponse,
  BatchHealResponse,
  ScanAuditPhase,
  ScanPhase,
  SingleHealResponse,
  SystemAnomaly,
} from './operational-types';

interface OperationNotice {
  type: 'success' | 'warning' | 'error';
  message: string;
}

export function SystemHealthPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const isViewer = user?.role === 'viewer';

  // Read-side authority data
  const health = useRead<Record<string, unknown>>('/api/system/health');
  const audit = useRead<Record<string, unknown>>('/api/system/audit/status');
  const alerts = useRead<Record<string, unknown>>('/api/alerts');
  const profiles = useRead<Record<string, unknown>>('/api/profiles');

  const profileList = useMemo(() => {
    if (!profiles.data) return [];
    const raw = profiles.data.profiles ?? profiles.data.items ?? profiles.data;
    if (Array.isArray(raw)) {
      return raw.map((item) => {
        if (typeof item === 'object' && item !== null && 'name' in item) {
          return String((item as Record<string, unknown>).name);
        }
        return '';
      }).filter(Boolean);
    }
    return [];
  }, [profiles.data]);

  // Operational state
  const [notice, setNotice] = useState<OperationNotice | null>(null);

  // 1. Analytics Recompute State
  const [isRecomputing, setIsRecomputing] = useState(false);

  // 2. Audit Scan State
  const [scanPhase, setScanPhase] = useState<ScanPhase>('IDLE');
  const [scannedTotal, setScannedTotal] = useState(0);
  const [anomalies, setAnomalies] = useState<SystemAnomaly[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isScanStale, setIsScanStale] = useState(false);

  // 3. Single Heal Modal State
  const [healModalAnomaly, setHealModalAnomaly] = useState<SystemAnomaly | null>(null);
  const [healProfile, setHealProfile] = useState('');
  const [isHealConfirmed, setIsHealConfirmed] = useState(false);
  const [isHealing, setIsHealing] = useState(false);

  // 4. Batch Heal Modal State
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchProfile, setBatchProfile] = useState('');
  const [isBatchConfirmed, setIsBatchConfirmed] = useState(false);
  const [isBatchHealing, setIsBatchHealing] = useState(false);

  const refreshAllReads = useCallback(() => {
    void health.mutate();
    void audit.mutate();
    void alerts.mutate();
  }, [health, audit, alerts]);

  // 1. Recompute Analytics Handler
  const handleRecomputeAnalytics = async () => {
    if (isViewer || isRecomputing) return;
    setIsRecomputing(true);
    setNotice(null);

    try {
      const res = await postJson<AnalyticsInitResponse>(
        '/api/analytics/init',
        buildAnalyticsInitRequest(),
      );
      setNotice({
        type: 'success',
        message:
          res?.message ||
          'Analytics snapshot recomputed. MongoDB analytics are computed from subscriber documents on demand.',
      });
      refreshAllReads();
    } catch (error) {
      const err = extractErrorMessage(0, error);
      setNotice({
        type: 'error',
        message: err.message || 'Failed to recompute analytics snapshot.',
      });
    } finally {
      setIsRecomputing(false);
    }
  };

  // 2. Audit Scan Pipeline
  const runScanStep = async (
    cursor: string,
    phase: ScanAuditPhase,
    accumulatedCount: number,
    accumulatedAnomalies: SystemAnomaly[],
  ) => {
    try {
      if (cursor === '0') {
        if (phase === 'sub') setScanPhase('SCAN_SUB');
        else if (phase === 'ocs') setScanPhase('SCAN_OCS');
        else if (phase === 'tariff') setScanPhase('SCAN_TARIFF');
        else if (phase === 'reservation') setScanPhase('SCAN_RESERVATIONS');
      }

      const requestPayload = buildAuditScanRequest(cursor, phase);
      const res = await postJson<AuditScanResponse>(
        '/api/system/audit/scan',
        requestPayload,
      );

      const newTotal = accumulatedCount + (res?.scannedCount || 0);
      const newAnomalies = [
        ...accumulatedAnomalies,
        ...(res?.anomalies || []),
      ];

      setScannedTotal(newTotal);
      setAnomalies(newAnomalies);

      const nextCursor = String(res?.nextCursor ?? '0');

      if (nextCursor !== '0') {
        // Sequential recursion in same phase
        await runScanStep(nextCursor, phase, newTotal, newAnomalies);
      } else {
        // Transition to next phase in order: sub -> ocs -> tariff -> reservation -> COMPLETE
        if (phase === 'sub') {
          await runScanStep('0', 'ocs', newTotal, newAnomalies);
        } else if (phase === 'ocs') {
          await runScanStep('0', 'tariff', newTotal, newAnomalies);
        } else if (phase === 'tariff') {
          await runScanStep('0', 'reservation', newTotal, newAnomalies);
        } else {
          setScanPhase('COMPLETE');
          setIsScanning(false);
          setIsScanStale(false);
          setNotice({
            type: 'success',
            message: `Diagnostic audit scan complete. Processed ${newTotal} items across 4 audit phases. Found ${newAnomalies.length} anomalies.`,
          });
          refreshAllReads();
        }
      }
    } catch (error) {
      setScanPhase('ABORTED');
      setIsScanning(false);
      const err = extractErrorMessage(0, error);
      setNotice({
        type: 'error',
        message: `Audit scan aborted during phase ${phase}: ${err.message}`,
      });
    }
  };

  const handleStartScan = async () => {
    if (isViewer || isScanning) return;
    setIsScanning(true);
    setNotice(null);
    setAnomalies([]);
    setScannedTotal(0);
    setScanPhase('INIT');

    await runScanStep('0', 'sub', 0, []);
  };

  // 3. Single Heal Execution
  const handleOpenSingleHeal = (anomaly: SystemAnomaly) => {
    if (isViewer) return;
    setHealModalAnomaly(anomaly);
    setHealProfile('');
    setIsHealConfirmed(false);
    setNotice(null);
  };

  const handleExecuteSingleHeal = async () => {
    if (isViewer || !healModalAnomaly || !isHealConfirmed || isHealing) return;
    setIsHealing(true);

    try {
      const payload = buildSingleHealRequest(
        healModalAnomaly,
        healProfile || undefined,
      );
      const res = await postJson<SingleHealResponse>(
        '/api/system/audit/heal',
        payload,
      );

      const targetImsi = healModalAnomaly.imsi;
      const targetType = healModalAnomaly.type;

      setAnomalies((prev) =>
        prev.filter((a) => !(a.imsi === targetImsi && a.type === targetType)),
      );

      setNotice({
        type: 'success',
        message:
          res?.message ||
          `Successfully applied targeted remediation for subscriber ${targetImsi}.`,
      });

      setHealModalAnomaly(null);
      refreshAllReads();
    } catch (error) {
      const err = extractErrorMessage(0, error);
      setNotice({
        type: 'error',
        message: `Single remediation failed: ${err.message}`,
      });
    } finally {
      setIsHealing(false);
    }
  };

  // 4. Batch Heal Execution
  const handleOpenBatchHeal = () => {
    if (isViewer || anomalies.length === 0) return;
    setBatchModalOpen(true);
    setBatchProfile('');
    setIsBatchConfirmed(false);
    setNotice(null);
  };

  const handleExecuteBatchHeal = async () => {
    if (isViewer || anomalies.length === 0 || !isBatchConfirmed || isBatchHealing) {
      return;
    }
    setIsBatchHealing(true);

    try {
      const payload = buildBatchHealRequest(
        anomalies,
        batchProfile || undefined,
      );
      const res = await postJson<BatchHealResponse>(
        '/api/system/audit/batch-heal',
        payload,
      );

      const successCount = res?.successCount ?? 0;
      const failedCount = res?.failedCount ?? 0;

      if (failedCount === 0) {
        // Complete success: safe to clear anomalies
        setAnomalies([]);
        setIsScanStale(false);
        setNotice({
          type: 'success',
          message:
            res?.message ||
            `Successfully resolved all ${successCount} batch anomalies.`,
        });
      } else {
        // Partial result semantics: do not falsely claim total success!
        setIsScanStale(true);
        const errorDetails =
          Array.isArray(res?.errors) && res.errors.length > 0
            ? ` Errors: ${res.errors.slice(0, 2).join('; ')}`
            : '';
        setNotice({
          type: 'warning',
          message: `Batch remediation partially completed: ${successCount} succeeded, ${failedCount} failed.${errorDetails} Scan data marked stale. Please run a fresh diagnostic audit.`,
        });
      }

      setBatchModalOpen(false);
      refreshAllReads();
    } catch (error) {
      const err = extractErrorMessage(0, error);
      setNotice({
        type: 'error',
        message: `Batch remediation failed: ${err.message}`,
      });
    } finally {
      setIsBatchHealing(false);
    }
  };

  const healthData = (health.data?.summary ?? health.data ?? {}) as Record<string, unknown>;

  /* Subsystem matrix. The contract reports four subsystems under `subsystems`;
   * each card renders a 2x2 metric grid, matching the reference layout. */
  const subsystems = (health.data?.subsystems ?? {}) as Record<string, Record<string, unknown>>;
  const sub = (key: string) => subsystems[key] ?? {};
  const subStatus = (key: string) => String(sub(key).status ?? 'healthy');
  const subValue = (key: string, field: string) => {
    const value = sub(key)[field];
    return value === undefined || value === null ? '--' : String(value);
  };
  const statusBadge = (key: string) => (
    <span className={`subsystem-badge ${subStatus(key)}`}>{t(`health_status_${subStatus(key)}`)}</span>
  );
  const toneOf = (key: string, field: string, whenPositive: 'success' | 'danger' | 'warning') =>
    Number(sub(key)[field] ?? 0) > 0 ? whenPositive : 'success';
  const auditData = (audit.data ?? {}) as Record<string, unknown>;
  const alertItems = useMemo(() => {
    if (!alerts.data) return [];
    const raw = alerts.data.alerts ?? alerts.data.items ?? alerts.data;
    return Array.isArray(raw) ? raw : [];
  }, [alerts.data]);

  return (
    <section className="read-page">
      <header className="read-page-header">
        <div>
          <p className="read-marker">{t('eyebrow_noc_diagnostics')}</p>
          <h1>{t('nav_system_health')}</h1>
          <p className="read-summary">{t('health_subsystems_title')}</p>
        </div>

        <div className="system-health-actions" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            className="read-refresh"
            onClick={refreshAllReads}
            disabled={health.isLoading || isScanning}
          >
            <RefreshCw size={16} />
            {t('refresh')}
          </button>

          <button
            type="button"
            className="read-refresh operational-btn"
            onClick={() => void handleRecomputeAnalytics()}
            disabled={isViewer || isRecomputing || isScanning}
            title={t('sync_tooltip')}
          >
            <Database size={16} />
            {t('sync_telemetry')}
          </button>

          <button
            type="button"
            className="read-refresh operational-btn"
            onClick={() => void handleStartScan()}
            disabled={isViewer || isScanning}
            title={t('health_btn_run')}
          >
            <Activity size={16} />
            {isScanning ? t('health_btn_scanning') : t('health_btn_run')}
          </button>

          {anomalies.length > 0 && (
            <button
              type="button"
              className="read-refresh operational-btn batch-heal-btn"
              onClick={handleOpenBatchHeal}
              disabled={isViewer || isScanning}
              title={isViewer ? 'Read-only access: viewer role cannot execute remediation' : undefined}
            >
              <Wrench size={16} />
              Batch Heal ({anomalies.length})
            </button>
          )}
        </div>
      </header>

      {/* Subsystem health matrix — four cards, each with a 2x2 metric grid. */}
      <section className="health-subsystems-section">
        <SectionHeader title={t('health_subsystems_title')} />

        <div className="health-subsystems-grid">
          <SubsystemCard
            status={subStatus('database')}
            icon={<Database size={20} color="var(--primary)" />}
            name={t('health_subsystem_db')}
            description={`${subValue('database', 'xcloudDb')} / ${subValue('database', 'appDb')}`}
            statusBadge={statusBadge('database')}
            metrics={[
              { label: t('health_db_latency'), value: `${subValue('database', 'latencyMs')} ms` },
              { label: t('health_db_collections'), value: `${subValue('database', 'existingCollections')} / ${subValue('database', 'totalCollections')}` },
              { label: t('health_db_indexes'), value: subValue('database', 'missingIndexesCount'), tone: toneOf('database', 'missingIndexesCount', 'danger') },
              { label: t('status'), value: sub('database').ready ? t('health_status_ready') : t('health_status_attention'), tone: sub('database').ready ? 'success' : 'danger' },
            ]}
          />

          <SubsystemCard
            status={subStatus('ocsEngine')}
            icon={<Zap size={20} color="var(--primary)" />}
            name={t('health_subsystem_ocs')}
            description={t('health_desc_ocs')}
            statusBadge={statusBadge('ocsEngine')}
            metrics={[
              { label: t('health_ocs_invariants'), value: sub('ocsEngine').invariantsOk ? t('health_status_ok') : t('health_status_broken', { count: subValue('ocsEngine', 'brokenInvariantsCount') }), tone: sub('ocsEngine').invariantsOk ? 'success' : 'danger' },
              { label: t('health_ocs_sessions'), value: subValue('ocsEngine', 'activeSessions') },
              { label: t('health_ocs_reservations'), value: subValue('ocsEngine', 'activeReservations') },
              { label: t('health_ocs_tariff_plans'), value: subValue('ocsEngine', 'activeTariffPlans') },
            ]}
          />

          <SubsystemCard
            status={subStatus('hssCore')}
            icon={<Layers size={20} color="var(--primary)" />}
            name={t('health_subsystem_hss')}
            description={t('health_desc_hss')}
            statusBadge={statusBadge('hssCore')}
            metrics={[
              { label: t('health_hss_auth_credentials'), value: Number(sub('hssCore').missingCredentialsCount ?? 0) > 0 ? t('health_status_invalid', { count: subValue('hssCore', 'missingCredentialsCount') }) : t('health_status_ok'), tone: toneOf('hssCore', 'missingCredentialsCount', 'danger') },
              { label: t('health_hss_slice_routing'), value: Number(sub('hssCore').missingSlicesCount ?? 0) > 0 ? t('health_status_missing', { count: subValue('hssCore', 'missingSlicesCount') }) : t('health_status_optimal'), tone: toneOf('hssCore', 'missingSlicesCount', 'danger') },
              { label: t('health_hss_dangling_profiles'), value: subValue('hssCore', 'danglingProfilesCount'), tone: toneOf('hssCore', 'danglingProfilesCount', 'warning') },
              { label: t('profiles_title'), value: subValue('hssCore', 'activeProfilesCount') },
            ]}
          />

          <SubsystemCard
            status={subStatus('security')}
            icon={<ShieldCheck size={20} color="var(--primary)" />}
            name={t('health_subsystem_security')}
            description={t('health_desc_sec')}
            statusBadge={statusBadge('security')}
            metrics={[
              { label: t('health_sec_root'), value: sub('security').rootUserConfigured ? t('health_status_active') : t('health_status_missing', { count: 1 }), tone: sub('security').rootUserConfigured ? 'success' : 'danger' },
              { label: t('health_sec_alerts'), value: subValue('security', 'unacknowledgedAlertsCount'), tone: toneOf('security', 'criticalAlertsCount', 'danger') },
              { label: t('users_title'), value: subValue('security', 'activeUsersCount') },
            ]}
          />
        </div>
      </section>

      {notice && (
        <aside
          role={notice.type === 'error' ? 'alert' : 'status'}
          className={`system-health-notice notice-${notice.type}`}
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            borderRadius: '4px',
            backgroundColor:
              notice.type === 'error'
                ? '#fee2e2'
                : notice.type === 'warning'
                ? '#fef3c7'
                : '#dcfce7',
            color:
              notice.type === 'error'
                ? '#991b1b'
                : notice.type === 'warning'
                ? '#92400e'
                : '#166534',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            &times;
          </button>
        </aside>
      )}

      {/* Subsystem Health Cards */}
      <section className="read-collection">
        <h2>Subsystem Status</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
            marginBottom: '1.5rem',
          }}
        >
          <article className="health-card" style={{ padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <Database size={18} color="#2563eb" />
              <strong>Data Persistence</strong>
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#4b5563' }}>
              Status: {String(healthData.mongo_status ?? healthData.database ?? 'operational')}
            </p>
          </article>

          <article className="health-card" style={{ padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <Activity size={18} color="#059669" />
              <strong>Audit State</strong>
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#4b5563' }}>
              Last Check: {auditData.lastSaveTime ? new Date(Number(auditData.lastSaveTime) * 1000).toLocaleTimeString() : 'N/A'}
            </p>
          </article>

          <article className="health-card" style={{ padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <ShieldAlert size={18} color="#d97706" />
              <strong>Active Alerts</strong>
            </div>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#4b5563' }}>
              Count: {alertItems.length}
            </p>
          </article>
        </div>
      </section>

      {/* Audit Scan Progress Indicator */}
      {isScanning && (
        <section
          className="scan-status-strip"
          style={{
            padding: '1rem',
            marginBottom: '1.5rem',
            backgroundColor: '#f0f9ff',
            border: '1px solid #bae6fd',
            borderRadius: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Clock size={16} color="#0284c7" />
            <span>
              Diagnostic audit running: Phase <strong>{scanPhase}</strong> (Processed: {scannedTotal} items, Anomalies found: {anomalies.length})
            </span>
          </div>
        </section>
      )}

      {/* Scan Anomalies Section */}
      <section className="read-collection">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Diagnostic Findings {anomalies.length > 0 ? `(${anomalies.length})` : ''}</h2>
          {isScanStale && (
            <span style={{ fontSize: '0.85rem', color: '#b45309', fontWeight: 500 }}>
              (Scan data is stale after partial remediation)
            </span>
          )}
        </div>

        {anomalies.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>
            {scanPhase === 'COMPLETE'
              ? 'No anomalies detected across all four audit scan phases.'
              : 'Click "Run Audit Scan" above to execute sequential diagnostic scanning across subscriber, OCS, tariff, and reservation records.'}
          </p>
        ) : (
          <div className="read-table-wrap">
            <table className="read-table">
              <caption className="sr-only">Diagnostic Anomalies</caption>
              <thead>
                <tr>
                  <th>IMSI</th>
                  <th>Anomaly Type</th>
                  <th>Category</th>
                  <th>Severity</th>
                  <th>Details</th>
                  <th>Remediation</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.map((anomaly, idx) => (
                  <tr key={`${anomaly.imsi}-${anomaly.type}-${idx}`}>
                    <td data-label="IMSI">{anomaly.imsi}</td>
                    <td data-label="Anomaly Type"><code>{anomaly.type}</code></td>
                    <td data-label="Category">{anomaly.category || 'subscriber'}</td>
                    <td data-label="Severity">
                      <span
                        style={{
                          padding: '0.2rem 0.5rem',
                          borderRadius: '3px',
                          fontSize: '0.8rem',
                          backgroundColor:
                            anomaly.severity === 'critical'
                              ? '#fee2e2'
                              : anomaly.severity === 'warning'
                              ? '#fef3c7'
                              : '#e0f2fe',
                          color:
                            anomaly.severity === 'critical'
                              ? '#991b1b'
                              : anomaly.severity === 'warning'
                              ? '#92400e'
                              : '#0369a1',
                        }}
                      >
                        {anomaly.severity || 'info'}
                      </span>
                    </td>
                    <td data-label="Details">{anomaly.details || 'Detected mismatch in document state.'}</td>
                    <td data-label="Remediation">
                      <button
                        type="button"
                        className="read-refresh"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                        onClick={() => handleOpenSingleHeal(anomaly)}
                        disabled={isViewer || isHealing}
                        title={isViewer ? 'Read-only access: viewer role cannot heal anomalies' : undefined}
                      >
                        <Wrench size={14} />
                        Heal
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Single Heal Confirmation Modal */}
      {healModalAnomaly && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="heal-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              padding: '1.5rem',
              borderRadius: '8px',
              maxWidth: '480px',
              width: '90%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h3 id="heal-modal-title" style={{ margin: '0 0 1rem 0' }}>
              Confirm Targeted Remediation
            </h3>
            <p style={{ fontSize: '0.9rem', color: '#4b5563', marginBottom: '1rem' }}>
              This operation applies targeted self-healing for subscriber document state.
            </p>

            <dl style={{ fontSize: '0.875rem', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <dt style={{ fontWeight: 600 }}>IMSI:</dt>
                <dd style={{ margin: 0 }}>{healModalAnomaly.imsi}</dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <dt style={{ fontWeight: 600 }}>Anomaly Type:</dt>
                <dd style={{ margin: 0 }}><code>{healModalAnomaly.type}</code></dd>
              </div>
            </dl>

            {profileList.length > 0 && (
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Remediation Profile (optional):
                <select
                  value={healProfile}
                  onChange={(e) => setHealProfile(e.target.value)}
                  style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '4px', border: '1px solid #d1d5db' }}
                >
                  <option value="">(Default Profile)</option>
                  {profileList.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            )}

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                marginBottom: '1.25rem',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={isHealConfirmed}
                onChange={(e) => setIsHealConfirmed(e.target.checked)}
              />
              <span>I confirm targeted remediation execution for this subscriber.</span>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                type="button"
                className="read-refresh"
                onClick={() => setHealModalAnomaly(null)}
                disabled={isHealing}
              >
                Cancel
              </button>
              <button
                type="button"
                className="read-refresh operational-btn"
                style={{ backgroundColor: '#dc2626', color: '#fff' }}
                onClick={() => void handleExecuteSingleHeal()}
                disabled={!isHealConfirmed || isHealing}
              >
                {isHealing ? 'Healing...' : 'Execute Remediation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Heal Confirmation Modal */}
      {batchModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              padding: '1.5rem',
              borderRadius: '8px',
              maxWidth: '480px',
              width: '90%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h3 id="batch-modal-title" style={{ margin: '0 0 1rem 0' }}>
              Confirm Batch Remediation ({anomalies.length} items)
            </h3>
            <p style={{ fontSize: '0.9rem', color: '#4b5563', marginBottom: '1rem' }}>
              Remediation will execute sequentially across all {anomalies.length} diagnostic findings.
            </p>

            {profileList.length > 0 && (
              <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '1rem' }}>
                Batch Remediation Profile (optional):
                <select
                  value={batchProfile}
                  onChange={(e) => setBatchProfile(e.target.value)}
                  style={{ display: 'block', width: '100%', marginTop: '0.25rem', padding: '0.5rem', borderRadius: '4px', border: '1px solid #d1d5db' }}
                >
                  <option value="">(Default Profile)</option>
                  {profileList.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            )}

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                marginBottom: '1.25rem',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={isBatchConfirmed}
                onChange={(e) => setIsBatchConfirmed(e.target.checked)}
              />
              <span>I confirm batch remediation execution for {anomalies.length} findings.</span>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                type="button"
                className="read-refresh"
                onClick={() => setBatchModalOpen(false)}
                disabled={isBatchHealing}
              >
                Cancel
              </button>
              <button
                type="button"
                className="read-refresh operational-btn"
                style={{ backgroundColor: '#dc2626', color: '#fff' }}
                onClick={() => void handleExecuteBatchHeal()}
                disabled={!isBatchConfirmed || isBatchHealing}
              >
                {isBatchHealing ? 'Batch Remediation in Progress...' : 'Execute Batch Remediation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
