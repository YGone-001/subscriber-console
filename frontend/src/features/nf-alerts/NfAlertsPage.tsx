/*
 * NF alert instances and rule management.
 *
 * Rules are pure observers over NF Health measurement evidence: they never
 * trigger collections and never modify the network. Dedupe windows (cooldown)
 * and recovery-driven clearing are enforced by the evaluation engine; this
 * page only reads results and performs governed mutations.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellRing, Check, CheckCheck, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import PageHeader from '../../components/ui/PageHeader';
import { OperationsNav } from '../operations/OperationsNav';
import { SkeletonKpiStrip } from '../../components/ui/LoadingSkeleton';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import {
  acknowledgeNfAlert,
  deleteNfAlertRule,
  fetchNfAlertRules,
  fetchNfAlerts,
  fetchNfAlertsMeta,
  resolveNfAlert,
} from './nf-alerts-api';
import type {
  Alert,
  AlertRule,
  AlertSeverity,
  NfAlertsMeta,
  RuleCondition,
} from './nf-alerts-types';
import { NfAlertRuleDialog } from './NfAlertRuleDialog';
import styles from '../../styles/modules/nf-alerts.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function NfAlertsPage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  const [meta, setMeta] = useState<NfAlertsMeta | null>(null);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [ruleSearchInput, setRuleSearchInput] = useState('');
  const [ruleSearchQuery, setRuleSearchQuery] = useState('');
  const [ruleEnabledFilter, setRuleEnabledFilter] = useState('');
  const [alertStateFilter, setAlertStateFilter] = useState('');
  const [alertSeverityFilter, setAlertSeverityFilter] = useState('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, rulesRes, alertsRes] = await Promise.all([
        fetchNfAlertsMeta().catch(() => null),
        fetchNfAlertRules({
          q: ruleSearchQuery || undefined,
          enabled: ruleEnabledFilter || undefined,
          limit: PAGE_LIMIT,
        }),
        fetchNfAlerts({
          state: alertStateFilter || undefined,
          severity: alertSeverityFilter || undefined,
          limit: PAGE_LIMIT,
        }),
      ]);
      setMeta(metaRes);
      setRules(rulesRes.rules ?? []);
      setAlerts(alertsRes.alerts ?? []);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('nf_alerts_err_load'));
      setRules([]);
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [ruleSearchQuery, ruleEnabledFilter, alertStateFilter, alertSeverityFilter, t]);

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setError(t('nf_alerts_err_forbidden'));
      return;
    }
    void loadAll();
  }, [canRead, loadAll]);

  const handleRuleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = ruleSearchInput.trim();
    if (next === ruleSearchQuery) {
      void loadAll();
      return;
    }
    setRuleSearchQuery(next);
  };

  const openCreate = () => {
    setEditingRule(null);
    setDialogOpen(true);
  };

  const openEdit = (rule: AlertRule) => {
    setEditingRule(rule);
    setDialogOpen(true);
  };

  const handleDeleteRule = async (rule: AlertRule) => {
    if (!window.confirm(t('nf_alerts_rule_delete_confirm', { name: rule.name }))) return;
    setBusyId(rule.ruleId);
    setFeedback(null);
    try {
      const result = await deleteNfAlertRule(rule.ruleId);
      setFeedback({
        tone: 'success',
        message: t('nf_alerts_feedback_rule_deleted', { count: result.resolvedAlerts }),
      });
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  const handleAcknowledge = async (alert: Alert) => {
    setBusyId(alert.alertId);
    setFeedback(null);
    try {
      await acknowledgeNfAlert(alert.alertId);
      setFeedback({ tone: 'success', message: t('nf_alerts_feedback_acknowledged') });
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  const handleResolve = async (alert: Alert) => {
    setBusyId(alert.alertId);
    setFeedback(null);
    try {
      await resolveNfAlert(alert.alertId);
      setFeedback({ tone: 'success', message: t('nf_alerts_feedback_resolved') });
      await loadAll();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  const kpis = useMemo(() => {
    let active = 0;
    let acknowledged = 0;
    let critical = 0;
    for (const alert of alerts) {
      if (alert.state === 'active') active += 1;
      else if (alert.state === 'acknowledged') acknowledged += 1;
      if (alert.severity === 'critical' && alert.state !== 'resolved') critical += 1;
    }
    return { rules: rules.length, active, acknowledged, critical };
  }, [rules, alerts]);

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('eyebrow_nf_alerts')}
        icon={<BellRing size={23} />}
        title={t('nf_alerts_title')}
        description={t('nf_alerts_description')}
        actions={(
          <>
            <button type="button" className="btn btn-secondary" onClick={() => void loadAll()} disabled={loading}>
              <RefreshCw size={16} className={loading ? styles.spin : undefined} />
              {t('refresh')}
            </button>
            {canConfigure ? (
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Plus size={16} />
                {t('nf_alerts_add_rule')}
              </button>
            ) : null}
          </>
        )}
      />

      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('nf_alerts_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      <OperationsNav />

      {loading && alerts.length === 0 && rules.length === 0 ? (
        <SkeletonKpiStrip count={4} />
      ) : (
        <section className={styles.kpiStrip} aria-label={t('nf_alerts_kpi_label')}>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_rules')}</span>
            <strong className={styles.kpiValue}>{kpis.rules}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_active')}</span>
            <strong className={styles.kpiValue}>{kpis.active}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_acknowledged')}</span>
            <strong className={styles.kpiValue}>{kpis.acknowledged}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_critical_open')}</span>
            <strong className={styles.kpiValue}>{kpis.critical}</strong>
          </article>
        </section>
      )}

      <section className="dash-card">
        <div className={styles.sectionHead}>
          <h2>
            <BellRing size={16} aria-hidden="true" />
            {t('nf_alerts_instances_section')}
          </h2>
          <span className={styles.sectionNote}>{t('nf_alerts_instances_note')}</span>
        </div>
        <div className={styles.toolbar}>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('nf_alerts_filter_state')}
              value={alertStateFilter}
              onChange={(event) => setAlertStateFilter(event.target.value)}
            >
              <option value="">{t('nf_alerts_filter_all_states')}</option>
              <option value="active">{t('nf_alerts_state_active')}</option>
              <option value="acknowledged">{t('nf_alerts_state_acknowledged')}</option>
              <option value="resolved">{t('nf_alerts_state_resolved')}</option>
            </select>
            <select
              className="form-input"
              aria-label={t('nf_alerts_filter_severity')}
              value={alertSeverityFilter}
              onChange={(event) => setAlertSeverityFilter(event.target.value)}
            >
              <option value="">{t('nf_alerts_filter_all_severities')}</option>
              <option value="critical">{t('nf_alerts_severity_critical')}</option>
              <option value="warning">{t('nf_alerts_severity_warning')}</option>
              <option value="info">{t('nf_alerts_severity_info')}</option>
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setAlertStateFilter('');
                setAlertSeverityFilter('');
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('nf_alerts_clear_filters')}
            </button>
          </div>
        </div>

        {error ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={error} retryLabel={t('nf_alerts_retry')} onRetry={() => void loadAll()} />
          </div>
        ) : loading && alerts.length === 0 ? (
          <LoadingRows columns={7} rows={4} />
        ) : alerts.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Bell size={44} />}
              title={t('nf_alerts_empty_alerts_title')}
              description={t('nf_alerts_empty_alerts_body')}
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('nf_alerts_instances_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('nf_alerts_col_rule')}</th>
                  <th scope="col">{t('nf_alerts_col_target')}</th>
                  <th scope="col">{t('nf_alerts_col_severity')}</th>
                  <th scope="col">{t('nf_alerts_col_state')}</th>
                  <th scope="col">{t('nf_alerts_col_triggers')}</th>
                  <th scope="col">{t('nf_alerts_col_last_triggered')}</th>
                  <th scope="col">{t('nf_alerts_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.alertId}>
                    <td>
                      <div className={styles.stack}>
                        <strong>{alert.ruleName}</strong>
                        <code className={styles.chip}>{conditionLabel(alert.conditionType, alert.condition, t)}</code>
                      </div>
                    </td>
                    <td>
                      <div className={styles.stack}>
                        <strong>{alert.targetName}</strong>
                        {alert.targetId ? (
                          <Link
                            to={`/nf-health/${encodeURIComponent(alert.targetId)}`}
                            className={styles.rowLink}
                            title={t('nf_alerts_link_target')}
                          >
                            {t('nf_alerts_link_target')}
                          </Link>
                        ) : null}
                      </div>
                    </td>
                    <td>{severityBadge(alert.severity, t)}</td>
                    <td>{alertStateBadge(alert.state, t)}</td>
                    <td>{alert.triggerCount}</td>
                    <td>{formatTimestamp(alert.lastTriggeredAt)}</td>
                    <td>
                      <div className={styles.rowActions}>
                        {alert.state === 'active' && canConfigure ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleAcknowledge(alert)}
                            disabled={busyId === alert.alertId}
                          >
                            <Check size={14} />
                            {t('nf_alerts_acknowledge_action')}
                          </button>
                        ) : null}
                        {alert.state !== 'resolved' && canConfigure ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => void handleResolve(alert)}
                            disabled={busyId === alert.alertId}
                          >
                            <CheckCheck size={14} />
                            {t('nf_alerts_resolve_action')}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dash-card">
        <div className={styles.sectionHead}>
          <h2>
            <Bell size={16} aria-hidden="true" />
            {t('nf_alerts_rules_section')}
          </h2>
          <span className={styles.sectionNote}>{t('nf_alerts_rules_note')}</span>
        </div>
        <div className={styles.toolbar}>
          <form className={styles.search} onSubmit={handleRuleSearchSubmit} role="search">
            <Search size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              type="search"
              value={ruleSearchInput}
              onChange={(event) => setRuleSearchInput(event.target.value)}
              placeholder={t('nf_alerts_search_placeholder')}
              aria-label={t('nf_alerts_search_placeholder')}
            />
            <button type="submit" className="btn btn-secondary">
              {t('search')}
            </button>
          </form>
          <div className={styles.filterGroup}>
            <select
              className="form-input"
              aria-label={t('nf_alerts_filter_enabled')}
              value={ruleEnabledFilter}
              onChange={(event) => setRuleEnabledFilter(event.target.value)}
            >
              <option value="">{t('nf_alerts_filter_all_states')}</option>
              <option value="true">{t('nf_alerts_rule_enabled')}</option>
              <option value="false">{t('nf_alerts_rule_disabled')}</option>
            </select>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setRuleSearchInput('');
                setRuleSearchQuery('');
                setRuleEnabledFilter('');
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('nf_alerts_clear_filters')}
            </button>
          </div>
        </div>
        <p className={styles.semanticNote}>{t('nf_alerts_semantic_note')}</p>

        {error ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={error} retryLabel={t('nf_alerts_retry')} onRetry={() => void loadAll()} />
          </div>
        ) : loading && rules.length === 0 ? (
          <LoadingRows columns={6} rows={4} />
        ) : rules.length === 0 ? (
          <div className={styles.stateWrap}>
            <EmptyState
              icon={<Bell size={44} />}
              title={t('nf_alerts_empty_rules_title')}
              description={t('nf_alerts_empty_rules_body')}
              action={
                canConfigure ? (
                  <button type="button" className="btn btn-primary" onClick={openCreate}>
                    <Plus size={16} />
                    {t('nf_alerts_add_rule')}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className="sr-only">{t('nf_alerts_rules_caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('nf_alerts_col_rule')}</th>
                  <th scope="col">{t('nf_alerts_col_scope')}</th>
                  <th scope="col">{t('nf_alerts_col_condition')}</th>
                  <th scope="col">{t('nf_alerts_col_severity')}</th>
                  <th scope="col">{t('nf_alerts_col_cooldown')}</th>
                  <th scope="col">{t('nf_alerts_col_enabled')}</th>
                  <th scope="col">{t('nf_alerts_col_actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.ruleId}>
                    <td>
                      <div className={styles.stack}>
                        <strong>{rule.name}</strong>
                        {rule.description ? <span className={styles.dim}>{rule.description}</span> : null}
                      </div>
                    </td>
                    <td>
                      {rule.targetId ? (
                        <span className={styles.chip} title={rule.targetId}>{t('nf_alerts_scope_single_target')}</span>
                      ) : rule.resourceId ? (
                        <Link to={`/inventory/${encodeURIComponent(rule.resourceId)}`} className={styles.rowLink}>
                          {t('nf_alerts_scope_resource')}
                        </Link>
                      ) : (
                        <span className={styles.chip}>{t('nf_alerts_scope_all_targets')}</span>
                      )}
                    </td>
                    <td>
                      <code className={styles.chip}>
                        {conditionLabel(rule.conditionType, rule.condition, t)}
                      </code>
                    </td>
                    <td>{severityBadge(rule.severity, t)}</td>
                    <td>{formatCooldown(rule.cooldownSeconds)}</td>
                    <td>
                      {rule.enabled ? (
                        <span className={styles.badgeEnabled}>{t('nf_alerts_rule_enabled')}</span>
                      ) : (
                        <span className={styles.badgeDisabled}>{t('nf_alerts_rule_disabled')}</span>
                      )}
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        {canConfigure ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => openEdit(rule)}
                            >
                              <Pencil size={14} />
                              {t('nf_alerts_edit_rule')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void handleDeleteRule(rule)}
                              disabled={busyId === rule.ruleId}
                            >
                              <Trash2 size={14} />
                              {t('nf_alerts_delete_rule')}
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <NfAlertRuleDialog
        open={dialogOpen}
        meta={meta}
        rule={editingRule}
        onClose={() => setDialogOpen(false)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', message });
          void loadAll();
        }}
        onFormError={(message) => setFeedback({ tone: 'danger', message })}
      />
    </div>
  );
}

function conditionLabel(
  conditionType: Alert['conditionType'],
  condition: RuleCondition | undefined,
  t: (key: string) => string,
): string {
  if (conditionType === 'run_failed') return t('nf_alerts_condition_run_failed');
  if (!condition) return t('nf_alerts_condition_state');
  return `${t(`nf_alerts_scope_${condition.scope}`)} = ${t(`nf_alerts_state_${condition.state}`)}`;
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

function alertStateBadge(state: Alert['state'], t: (key: string) => string): React.ReactElement {
  if (state === 'active') return <span className={styles.badgeUnhealthy}>{t('nf_alerts_state_active')}</span>;
  if (state === 'acknowledged') return <span className={styles.badgeAcknowledged}>{t('nf_alerts_state_acknowledged')}</span>;
  return <span className={styles.badgeEnabled}>{t('nf_alerts_state_resolved')}</span>;
}

function formatCooldown(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function describeMutationError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'NF_ALERT_RULE_NOT_FOUND':
        return t('nf_alerts_err_rule_not_found');
      case 'NF_ALERT_INSTANCE_NOT_FOUND':
        return t('nf_alerts_err_alert_not_found');
      case 'NF_ALERT_REVISION_CONFLICT':
        return t('nf_alerts_err_revision_conflict');
      case 'NF_ALERT_INSTANCE_RESOLVED':
        return t('nf_alerts_err_alert_resolved');
      default:
        return err.message;
    }
  }
  return err instanceof Error && err.message ? err.message : t('nf_alerts_err_load');
}
