/*
 * NF alert evidence drawer.
 *
 * Answers the only two questions a duty operator has about a row: what was
 * measured when the alert was raised, and what has happened to it since. The
 * evidence snapshot is immutable - acknowledging or resolving never rewrites
 * it - so it is rendered as a read-only block next to the lifecycle timeline.
 */
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Check, CheckCheck, X } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import type { LayerEvidence, LayerState } from '../nf-health/nf-health-types';
import type { Alert, AlertSeverity, AlertState, ResolveReason } from './nf-alerts-types';
import styles from '../../styles/modules/nf-alerts.module.css';

type Props = {
  alert: Alert | null;
  canConfigure: boolean;
  busy: boolean;
  onClose: () => void;
  onAcknowledge: (alert: Alert) => void;
  onResolve: (alert: Alert) => void;
};

export function NfAlertEvidenceDrawer({
  alert,
  canConfigure,
  busy,
  onClose,
  onAcknowledge,
  onResolve,
}: Props) {
  const { t } = useI18n();
  if (!alert) return null;

  const evidence = alert.evidence;

  const content = (
    <div className={styles.drawerLayer} role="dialog" aria-modal="true" aria-label={t('nf_alerts_drawer_title')}>
      <div className={styles.drawer} id="nf-alert-evidence-title">
        <header className={styles.drawerHead}>
          <div>
            <h2 className={styles.drawerTitle}>{alert.ruleName}</h2>
            <p className={styles.drawerSub}>
              {severityBadge(alert.severity, t)}
              {alertStateBadge(alert.state, t)}
            </p>
          </div>
          <div className={styles.drawerHeadActions}>
            {alert.state === 'active' && canConfigure ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onAcknowledge(alert)}
                disabled={busy}
              >
                <Check size={15} />
                {t('nf_alerts_acknowledge_action')}
              </button>
            ) : null}
            {alert.state !== 'resolved' && canConfigure ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onResolve(alert)}
                disabled={busy}
              >
                <CheckCheck size={15} />
                {t('nf_alerts_resolve_action')}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={onClose} aria-label={t('nf_alerts_close')}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className={styles.drawerBody}>
          <section className={styles.drawerSection}>
            <h3 className={styles.drawerSectionTitle}>{t('nf_alerts_drawer_subject')}</h3>
            <div className={styles.detailGrid}>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t('nf_alerts_col_target')}</span>
                <span className={styles.detailValue}>
                  <strong>{alert.targetName}</strong>
                  {alert.targetId ? (
                    <Link
                      to={`/nf-health/${encodeURIComponent(alert.targetId)}`}
                      className={styles.rowLink}
                    >
                      {t('nf_alerts_link_target')}
                    </Link>
                  ) : null}
                </span>
              </div>
              {alert.resourceId ? (
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_drawer_resource')}</span>
                  <span className={styles.detailValue}>
                    <Link
                      to={`/inventory/${encodeURIComponent(alert.resourceId)}`}
                      className={styles.rowLink}
                    >
                      {alert.resourceId}
                    </Link>
                  </span>
                </div>
              ) : null}
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t('nf_alerts_col_condition')}</span>
                <span className={styles.detailValue}>
                  <code className={styles.chip}>
                    {conditionLabel(alert, t)}
                  </code>
                </span>
              </div>
            </div>
          </section>

          <section className={styles.drawerSection}>
            <h3 className={styles.drawerSectionTitle}>{t('nf_alerts_drawer_lifecycle')}</h3>
            <div className={styles.detailGrid}>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t('nf_alerts_lifecycle_triggers')}</span>
                <span className={styles.detailValue}>{alert.triggerCount}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t('nf_alerts_lifecycle_first')}</span>
                <span className={styles.detailValue}>{formatTimestamp(alert.firstTriggeredAt)}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>{t('nf_alerts_lifecycle_last')}</span>
                <span className={styles.detailValue}>{formatTimestamp(alert.lastTriggeredAt)}</span>
              </div>
              {alert.acknowledgedAt ? (
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_lifecycle_acknowledged')}</span>
                  <span className={styles.detailValue}>
                    {formatTimestamp(alert.acknowledgedAt)}
                    {alert.acknowledgedBy ? ` (${alert.acknowledgedBy})` : ''}
                  </span>
                </div>
              ) : null}
              {alert.resolvedAt ? (
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_lifecycle_resolved')}</span>
                  <span className={styles.detailValue}>
                    {formatTimestamp(alert.resolvedAt)}
                    {alert.resolvedReason ? ` (${resolveReasonLabel(alert.resolvedReason, t)})` : ''}
                  </span>
                </div>
              ) : null}
            </div>
          </section>

          <section className={styles.drawerSection}>
            <h3 className={styles.drawerSectionTitle}>{t('nf_alerts_drawer_evidence')}</h3>
            {evidence ? (
              <div className={styles.detailGrid}>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_evidence_run_status')}</span>
                  <span className={styles.detailValue}>
                    {evidence.runStatus
                      ? <span className={runStatusClass(evidence.runStatus)}>{evidence.runStatus}</span>
                      : '-'}
                  </span>
                </div>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_evidence_overall')}</span>
                  <span className={styles.detailValue}>
                    {evidence.overallState
                      ? <span className={overallStateClass(evidence.overallState)}>{evidence.overallState}</span>
                      : '-'}
                  </span>
                </div>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_evidence_collected')}</span>
                  <span className={styles.detailValue}>{formatTimestamp(evidence.collectedAt)}</span>
                </div>
                <div className={styles.detailRow}>
                  <span className={styles.detailLabel}>{t('nf_alerts_evidence_sample')}</span>
                  <span className={styles.detailValue}>
                    {evidence.sampleId ? <code className={styles.uuid}>{evidence.sampleId}</code> : '-'}
                  </span>
                </div>
                {evidence.layers ? (
                  <div className={styles.detailRow}>
                    <span className={styles.detailLabel}>{t('nf_alerts_evidence_layers')}</span>
                    <span className={styles.detailValue}>
                      {(['process', 'interface', 'service'] as const).map((layer) => (
                        <span key={layer} className={styles.layerRow}>
                          <span className={styles.layerName}>
                            {layer === 'process'
                              ? t('nf_health_layer_l1')
                              : layer === 'interface'
                                ? t('nf_health_layer_l2')
                                : t('nf_health_layer_l3')}
                          </span>
                          {layerBadge(evidence.layers?.[layer], t)}
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className={styles.semanticNote}>{t('nf_alerts_no_evidence')}</p>
            )}
            <p className={styles.semanticNote}>{t('nf_alerts_evidence_immutable')}</p>
          </section>
        </div>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

function layerBadge(evidence: LayerEvidence | undefined, t: (key: string) => string): React.ReactElement {
  if (!evidence || !evidence.measured) {
    return <span className={styles.badgeMuted}>{t('nf_health_state_unknown')}</span>;
  }
  const className =
    evidence.state === 'healthy'
      ? styles.badgeHealthy
      : evidence.state === 'degraded'
        ? styles.badgeDegraded
        : evidence.state === 'unhealthy'
          ? styles.badgeUnhealthy
          : evidence.state === 'not_configured'
            ? styles.badgeMuted
            : styles.badgeMuted;
  return <span className={className}>{layerStateLabel(evidence.state, t)}</span>;
}

function layerStateLabel(state: LayerState, t: (key: string) => string): string {
  const key = `nf_health_state_${state}`;
  const label = t(key);
  return label === key ? state : label;
}

function runStatusClass(status: string): string {
  if (status === 'success') return styles.badgeHealthy;
  if (status === 'partial') return styles.badgeWarning;
  return styles.badgeUnhealthy;
}

function overallStateClass(state: string): string {
  if (state === 'healthy') return styles.badgeHealthy;
  if (state === 'degraded') return styles.badgeDegraded;
  if (state === 'unhealthy') return styles.badgeUnhealthy;
  return styles.badgeMuted;
}

function severityBadge(severity: AlertSeverity, t: (key: string) => string): React.ReactElement {
  const label =
    severity === 'critical'
      ? t('nf_alerts_severity_critical')
      : severity === 'warning'
        ? t('nf_alerts_severity_warning')
        : t('nf_alerts_severity_info');
  const className =
    severity === 'critical'
      ? styles.badgeCritical
      : severity === 'warning'
        ? styles.badgeWarning
        : styles.badgeInfo;
  return <span className={className}>{label}</span>;
}

function alertStateBadge(state: AlertState, t: (key: string) => string): React.ReactElement {
  if (state === 'active') return <span className={styles.badgeUnhealthy}>{t('nf_alerts_state_active')}</span>;
  if (state === 'acknowledged') return <span className={styles.badgeAcknowledged}>{t('nf_alerts_state_acknowledged')}</span>;
  return <span className={styles.badgeEnabled}>{t('nf_alerts_state_resolved')}</span>;
}

function conditionLabel(alert: Alert, t: (key: string) => string): string {
  if (alert.conditionType === 'run_failed') return t('nf_alerts_condition_run_failed');
  if (!alert.condition) return t('nf_alerts_condition_state');
  return `${t(`nf_alerts_scope_${alert.condition.scope}`)} = ${t(`nf_alerts_state_${alert.condition.state}`)}`;
}

function resolveReasonLabel(reason: ResolveReason, t: (key: string) => string): string {
  const key = `nf_alerts_resolve_${reason}`;
  const label = t(key);
  return label === key ? reason : label;
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
