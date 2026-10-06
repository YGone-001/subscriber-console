/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/NocSentinel.tsx
 *
 * Adaptations, all at the runtime boundary:
 *   - `@/` aliases repointed; the local stylesheet import dropped because
 *     `styles/noc-sentinel.css` is already loaded through the stylesheet entry layer.
 *   - The raw `fetch` for the workflow mutation replaced by the current mutation
 *     client, so the shared error contract and the no-auto-retry rule apply.
 *   - `useSWR` + the current `fetcher` kept, because the surface needs its 15s poll.
 *   - An explicit neutral state added for the case where the alert authority is
 *     unreachable: the reference rendered an empty list, which reads as "all clear"
 *     and would invent a healthy posture out of a failed request.
 *
 * The activation card, monitor row, workflow summary, assignee row and action grid
 * are the reference's, including its class vocabulary.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CheckSquare,
  Play,
  Settings2,
  ShieldCheck,
  UserRoundCheck,
  Wrench,
} from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { fetcher } from '../../lib/fetcher';
import { postJson } from '../../lib/api/mutation-client';

interface AlertItem {
  id: string;
  level: string;
  timestamp: string;
  imsi?: string;
  reason: string;
  is_acknowledged?: boolean;
  workflow_status?: AlertWorkflowStatus;
  assigned_to?: string;
  handling_note?: string;
  workflow_updated_at?: string;
}

interface AlertResponse {
  activeCriticalCount?: number;
  activeWarningCount?: number;
  alerts?: AlertItem[];
}

type AlertWorkflowStatus = 'triage' | 'acknowledged' | 'assigned' | 'recovering' | 'resolved';

const MONITOR_STORAGE_KEY = 'xcloud_sentinel_monitor';

const ASSIGNEE_OPTIONS = ['NOC L1', 'Packet Core L2', 'Billing/OCS', 'Security', 'Platform SRE'];

const deptKeyMap: Record<string, string> = {
  'NOC L1': 'dept_noc_l1',
  'Packet Core L2': 'dept_core_l2',
  'Billing/OCS': 'dept_bss_ocs',
  Security: 'dept_security',
  'Platform SRE': 'dept_sre',
};

const WORKFLOW_CLASS: Record<AlertWorkflowStatus, string> = {
  triage: 'triage',
  acknowledged: 'acknowledged',
  assigned: 'assigned',
  recovering: 'recovering',
  resolved: 'resolved',
};

function getWorkflowStatus(alert: AlertItem): AlertWorkflowStatus {
  if (
    alert.workflow_status === 'acknowledged' ||
    alert.workflow_status === 'assigned' ||
    alert.workflow_status === 'recovering' ||
    alert.workflow_status === 'resolved'
  ) {
    return alert.workflow_status;
  }
  return alert.is_acknowledged ? 'resolved' : 'triage';
}

function defaultAssignee(alert: AlertItem) {
  if (alert.assigned_to) return alert.assigned_to;
  if (alert.reason.toLowerCase().includes('ocs')) return 'Billing/OCS';
  if (alert.imsi) return 'Packet Core L2';
  return 'Platform SRE';
}

export function NocSentinel() {
  const { t } = useI18n();
  const { data, error, mutate } = useSWR<AlertResponse>('/api/alerts', fetcher, {
    refreshInterval: 15000,
    revalidateOnFocus: true,
    errorRetryInterval: 30000,
  });
  const [, forceMonitorRefresh] = useState(0);
  const monitorActive = useSyncExternalStore(
    () => () => undefined,
    () => {
      try { return localStorage.getItem(MONITOR_STORAGE_KEY) === 'true'; } catch { return false; }
    },
    () => false,
  );
  const [expanded, setExpanded] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [draftOwners, setDraftOwners] = useState<Record<string, string>>({});
  const [busyAlertId, setBusyAlertId] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const alarmOscillatorRef = useRef<OscillatorNode | null>(null);
  const alarmGainRef = useRef<GainNode | null>(null);

  const activeCriticalCount = data?.activeCriticalCount || 0;
  const activeWarningCount = data?.activeWarningCount || 0;
  const activeAlerts = (data?.alerts || []).filter((alert) => !alert.is_acknowledged);
  const workflowSummary = useMemo(
    () =>
      activeAlerts.reduce(
        (summary, alert) => {
          summary[getWorkflowStatus(alert)] += 1;
          return summary;
        },
        { triage: 0, acknowledged: 0, assigned: 0, recovering: 0, resolved: 0 } as Record<AlertWorkflowStatus, number>,
      ),
    [activeAlerts],
  );
  const activeCount = activeCriticalCount + activeWarningCount;
  const hasCritical = activeCriticalCount > 0;
  const hasWarning = activeWarningCount > 0;
  const needsActivation = !monitorActive || audioBlocked;
  /* A failed request must not read as "all clear". */
  const unavailable = Boolean(error) && !data;

  useEffect(() => {
    document.body.classList.toggle('global-emergency-flash', hasCritical);
    return () => {
      document.body.classList.remove('global-emergency-flash');
    };
  }, [hasCritical]);

  const setAlarmVolume = (volume: number) => {
    const context = audioContextRef.current;
    const gain = alarmGainRef.current;
    if (!context || !gain || context.state === 'closed') return;
    gain.gain.setTargetAtTime(volume, context.currentTime, 0.02);
  };

  const activateAlarmEngine = async () => {
    try {
      let context = audioContextRef.current;
      if (!context || context.state === 'closed') {
        context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.value = 880;
        gain.gain.value = 0;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        audioContextRef.current = context;
        alarmOscillatorRef.current = oscillator;
        alarmGainRef.current = gain;
      }
      await context.resume();
      setAlarmVolume(hasCritical ? 0.035 : 0);
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  };

  useEffect(() => {
    const context = audioContextRef.current;
    if (!monitorActive || !hasCritical) {
      setAlarmVolume(0);
      return;
    }
    if (!context || context.state === 'closed') {
      setAudioBlocked(true);
      return;
    }
    void context.resume()
      .then(() => {
        setAlarmVolume(0.035);
        setAudioBlocked(false);
      })
      .catch(() => setAudioBlocked(true));
  }, [hasCritical, monitorActive]);

  useEffect(() => () => {
    try { alarmOscillatorRef.current?.stop(); } catch { /* already stopped */ }
    void audioContextRef.current?.close();
  }, []);

  const toggleMonitor = async (value: boolean) => {
    try { localStorage.setItem(MONITOR_STORAGE_KEY, String(value)); } catch { /* preference persistence is optional */ }
    forceMonitorRefresh((current) => current + 1);
    if (value) {
      await activateAlarmEngine();
    } else {
      setAlarmVolume(0);
      setAudioBlocked(false);
    }
  };

  const persistAlertWorkflow = async (alert: AlertItem, status: Exclude<AlertWorkflowStatus, 'triage'>) => {
    const assignedTo = draftOwners[alert.id] || defaultAssignee(alert);
    /* Through the mutation client: the shared error contract applies and nothing is
     * retried automatically. */
    await postJson('/api/alerts/workflow', {
      id: alert.id,
      status,
      assignedTo,
      note: t(`noc_workflow_note_${status}`),
    });
  };

  const updateAlertWorkflow = async (alert: AlertItem, status: Exclude<AlertWorkflowStatus, 'triage'>) => {
    setBusyAlertId(alert.id);
    try {
      await persistAlertWorkflow(alert, status);
      await mutate();
    } finally {
      setBusyAlertId(null);
    }
  };

  const handleAcknowledgeAll = async () => {
    if (activeAlerts.length === 0) return;
    setBusyAlertId('all');
    try {
      await Promise.all(activeAlerts.map((alert) => persistAlertWorkflow(alert, 'acknowledged')));
      await mutate();
    } finally {
      setBusyAlertId(null);
    }
  };

  const statusClass = unavailable ? 'muted' : hasCritical ? 'critical' : hasWarning ? 'warning' : needsActivation ? 'muted' : 'healthy';
  const statusLabel = unavailable
    ? t('noc_unavailable')
    : hasCritical
      ? t('noc_status_critical')
      : hasWarning
        ? t('noc_status_warning')
        : needsActivation
          ? t('noc_status_setup')
          : t('noc_status_online');

  return (
    <div className="noc-sentinel">
      {hasCritical ? (
        <div className="noc-critical-ticker">
          <AlertTriangle size={18} />
          <div>
            {t('noc_fault_detected')}{' '}
            {activeAlerts
              .filter((alert) => alert.level === 'CRITICAL')
              .map((alert) => `${alert.imsi || 'SYS'}: ${alert.reason}`)
              .join(' | ')}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className={`noc-header-button ${statusClass}`}
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        title={t('noc_alerts_title')}
      >
        <span className="noc-button-icon">
          {hasCritical || hasWarning ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
        </span>
        <span className="noc-button-label">NOC</span>
        {activeCount > 0 ? <span className="noc-count">{activeCount}</span> : null}
      </button>

      {expanded ? (
        <>
          <div className="noc-panel-backdrop" onClick={() => setExpanded(false)} />
          <section className="noc-panel">
            <div className="noc-panel-header">
              <div>
                <h3>
                  <Bell size={18} />
                  {t('noc_panel_title')}
                </h3>
                <span>{statusLabel}</span>
              </div>
              {activeAlerts.length > 0 ? (
                <button type="button" className="noc-ghost-button" onClick={() => void handleAcknowledgeAll()}>
                  {t('noc_ack_all')}
                </button>
              ) : null}
            </div>

            {needsActivation && !unavailable ? (
              <div className="noc-activation-card">
                <div className="noc-activation-title">
                  <Settings2 size={16} />
                  {audioBlocked ? t('noc_browser_blocked') : t('noc_hardware_blocked')}
                </div>
                <p>{audioBlocked ? t('noc_browser_blocked_desc') : t('noc_autoplay_blocked_desc')}</p>
                <button type="button" className="btn btn-primary noc-activate-button" onClick={() => void toggleMonitor(true)}>
                  <Play size={15} />
                  {audioBlocked ? t('noc_btn_reauthorize') : t('noc_btn_activate')}
                </button>
              </div>
            ) : null}

            <div className="noc-monitor-row">
              <label>
                <input type="checkbox" checked={monitorActive} onChange={(event) => void toggleMonitor(event.target.checked)} />
                {t('noc_keep_active')}
              </label>
            </div>

            {activeAlerts.length > 0 ? (
              <div className="noc-workflow-summary">
                <span>{t('noc_workflow_triage')}: {workflowSummary.triage}</span>
                <span>{t('noc_workflow_acknowledged')}: {workflowSummary.acknowledged}</span>
                <span>{t('noc_workflow_assigned')}: {workflowSummary.assigned}</span>
                <span>{t('noc_workflow_recovering')}: {workflowSummary.recovering}</span>
              </div>
            ) : null}

            <div className="noc-alert-list">
              {unavailable ? (
                <div className="noc-empty">
                  <ShieldCheck size={42} />
                  <strong>{t('noc_unavailable')}</strong>
                  <span>{t('noc_unavailable_body')}</span>
                </div>
              ) : activeAlerts.length === 0 ? (
                <div className="noc-empty">
                  <ShieldCheck size={42} />
                  <strong>{t('noc_systems_operational')}</strong>
                  <span>{t('noc_no_alerts')}</span>
                </div>
              ) : (
                activeAlerts.map((alert) => {
                  const workflowStatus = getWorkflowStatus(alert);
                  const owner = draftOwners[alert.id] || defaultAssignee(alert);
                  const isBusy = busyAlertId === alert.id || busyAlertId === 'all';
                  const canRecover = workflowStatus === 'assigned' || workflowStatus === 'recovering';

                  return (
                    <article className={alert.level === 'CRITICAL' ? 'noc-alert critical' : 'noc-alert'} key={alert.id}>
                      <AlertTriangle size={19} />
                      <div className="noc-alert-content">
                        <div className="noc-alert-meta">
                          {new Date(alert.timestamp).toLocaleTimeString()} | IMSI: <span>{alert.imsi || 'N/A'}</span>
                        </div>
                        <div className="noc-alert-reason">{alert.reason}</div>
                        <div className="noc-workflow-row">
                          <span className={`noc-workflow-pill ${WORKFLOW_CLASS[workflowStatus]}`}>
                            {t(`noc_workflow_${workflowStatus}`)}
                          </span>
                          {alert.workflow_updated_at ? <span>{new Date(alert.workflow_updated_at).toLocaleTimeString()}</span> : null}
                        </div>
                        {alert.handling_note ? <div className="noc-alert-note">{alert.handling_note}</div> : null}
                        <div className="noc-assignee-row">
                          <label htmlFor={`noc-assignee-${alert.id}`}>{t('noc_assignee')}</label>
                          <select
                            id={`noc-assignee-${alert.id}`}
                            value={owner}
                            onChange={(event) => setDraftOwners((current) => ({ ...current, [alert.id]: event.target.value }))}
                            disabled={isBusy}
                          >
                            {ASSIGNEE_OPTIONS.map((item) => (
                              <option value={item} key={item}>
                                {deptKeyMap[item] ? t(deptKeyMap[item]) : item}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="noc-action-grid">
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button"
                            onClick={() => void updateAlertWorkflow(alert, 'acknowledged')}
                            disabled={isBusy || workflowStatus !== 'triage'}
                          >
                            <CheckSquare size={14} />
                            {t('noc_btn_ack')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button"
                            onClick={() => void updateAlertWorkflow(alert, 'assigned')}
                            disabled={isBusy || workflowStatus === 'recovering'}
                          >
                            <UserRoundCheck size={14} />
                            {t('noc_btn_assign')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button"
                            onClick={() => void updateAlertWorkflow(alert, 'recovering')}
                            disabled={isBusy || !canRecover}
                          >
                            <Wrench size={14} />
                            {t('noc_btn_recovering')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline noc-action-button resolve"
                            onClick={() => void updateAlertWorkflow(alert, 'resolved')}
                            disabled={isBusy}
                          >
                            <CheckCircle2 size={14} />
                            {t('noc_btn_resolve')}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
