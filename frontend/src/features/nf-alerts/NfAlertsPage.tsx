/*
 * NF alerts duty workspace.
 *
 * Three exclusive views share one route:
 *
 *   view=open      the duty queue: active and acknowledged alerts, ordered by
 *                  the server so critical open work leads and resolved noise
 *                  never appears
 *   view=history   resolved alerts, most recently triggered first
 *   view=rules     rule configuration
 *
 * Rules are pure observers over NF Health evidence: they never trigger
 * collections and never modify the network. The evidence snapshot is written
 * when an alert is raised; acknowledging or resolving it never rewrites that
 * snapshot.
 *
 * Section-split integrity: the alert queue, the rule list and the KPI summary
 * each own their loading and error state, so a failing rule read can never
 * blank the queue.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellRing, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState, LoadingRows, OperationFeedback } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import {
  alertsKpisFromSummary,
  fetchOperationsSummary,
  type AlertsSummarySection,
} from '../operations/operations-summary';
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
import {
  ALERT_SEVERITIES,
  ALERT_URL_KEYS,
  ALERT_VIEWS,
  alertListQuery,
  alertView,
  readAlertFilters,
} from './nf-alert-views';
import type {
  Alert,
  AlertRule,
  AlertSeverity,
  AlertState,
  NfAlertsMeta,
  PageInfo,
  RuleCondition,
} from './nf-alerts-types';
import { NfAlertEvidenceDrawer } from './NfAlertEvidenceDrawer';
import { NfAlertRuleDialog } from './NfAlertRuleDialog';
import styles from '../../styles/modules/nf-alerts.module.css';

const PAGE_LIMIT = 20;

type Feedback = { tone: 'success' | 'danger' | 'warning' | 'info'; message: string } | null;

export function NfAlertsPage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const canRead = hasPermission(user, 'core.read');
  const canConfigure = hasPermission(user, 'core.configure');

  /* The view, the severity filter, the rule query and the rule enabled filter
   * live in the URL. Switching view resets the cursor through the shared
   * contract, so page N of a discarded queue is never requested. */
  const url = useOperationsUrlState({
    keys: ALERT_URL_KEYS,
    views: ALERT_VIEWS,
    defaultView: 'open',
  });
  const view = alertView(url.view);
  const filters = useMemo(() => readAlertFilters(url.filters), [url.filters]);

  const [meta, setMeta] = useState<NfAlertsMeta | null>(null);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsPage, setAlertsPage] = useState<PageInfo | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [alertsHistory, setAlertsHistory] = useState<string[]>([]);

  const [rules, setRules] = useState<AlertRule[]>([]);
  const [rulesPage, setRulesPage] = useState<PageInfo | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesHistory, setRulesHistory] = useState<string[]>([]);

  const [summary, setSummary] = useState<AlertsSummarySection | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);

  const [ruleSearchInput, setRuleSearchInput] = useState(filters.q);
  useEffect(() => {
    setRuleSearchInput(filters.q);
  }, [filters.q]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await fetchOperationsSummary(['alerts']);
      setSummary(res.alerts ?? null);
    } catch {
      // A failed summary only degrades the KPI strip to explicit unavailable
      // labels; the views load their own bounded lists.
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const loadAlerts = useCallback(async (cursor: string | undefined) => {
    setAlertsLoading(true);
    setAlertsError(null);
    try {
      const res = await fetchNfAlerts(alertListQuery(view, filters, cursor, PAGE_LIMIT));
      setAlerts(res.alerts ?? []);
      setAlertsPage(res.page ?? null);
    } catch (err) {
      setAlerts([]);
      setAlertsPage(null);
      setAlertsError(describeLoadError(err, t));
    } finally {
      setAlertsLoading(false);
    }
  }, [view, filters, t]);

  const loadRules = useCallback(async (cursor: string | undefined) => {
    setRulesLoading(true);
    setRulesError(null);
    try {
      const res = await fetchNfAlertRules({
        q: filters.q || undefined,
        enabled: filters.enabled || undefined,
        cursor,
        limit: PAGE_LIMIT,
      });
      setRules(res.rules ?? []);
      setRulesPage(res.page ?? null);
    } catch (err) {
      setRules([]);
      setRulesPage(null);
      setRulesError(describeLoadError(err, t));
    } finally {
      setRulesLoading(false);
    }
  }, [filters.q, filters.enabled, t]);

  /* One effect owns the read for the visible view, so a view switch or a filter
   * change issues exactly one bounded request and never a duplicate from a
   * pager handler. */
  useEffect(() => {
    if (!canRead) {
      setAlertsLoading(false);
      setRulesLoading(false);
      setSummaryLoading(false);
      setAlertsError(t('nf_alerts_err_forbidden'));
      setRulesError(t('nf_alerts_err_forbidden'));
      return;
    }
    if (view === 'rules') {
      void loadRules(url.cursor);
      return;
    }
    void loadAlerts(url.cursor);
  }, [canRead, view, url.cursor, loadAlerts, loadRules, t]);

  /* A pager position only means something for one filter set, so the view and
   * the filters - not the load itself - reset the page counter. */
  useEffect(() => {
    setAlertsHistory([]);
    setRulesHistory([]);
  }, [view, filters.severity, filters.q, filters.enabled]);

  useEffect(() => {
    if (!canRead) return;
    void loadSummary();
  }, [canRead, loadSummary]);

  useEffect(() => {
    if (!canRead) return;
    fetchNfAlertsMeta()
      .then(setMeta)
      .catch(() => {
        /* The rule dialog falls back to its own defaults when meta fails. */
      });
  }, [canRead]);

  const handleRefresh = () => {
    if (view === 'rules') {
      void loadRules(url.cursor);
    } else {
      void loadAlerts(url.cursor);
    }
    void loadSummary();
  };

  const handleRuleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = ruleSearchInput.trim();
    if (next === filters.q) {
      void loadRules(url.cursor);
      return;
    }
    url.setFilter('q', next);
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
      await loadRules(url.cursor);
      void loadSummary();
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
      const updated = await acknowledgeNfAlert(alert.alertId);
      setSelectedAlert((current) => (current && current.alertId === updated.alertId ? updated : current));
      setFeedback({ tone: 'success', message: t('nf_alerts_feedback_acknowledged') });
      await loadAlerts(url.cursor);
      void loadSummary();
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
      // A resolved alert belongs to the history view, so the drawer closes
      // instead of showing a row that is no longer part of this queue.
      setSelectedAlert(null);
      setFeedback({ tone: 'success', message: t('nf_alerts_feedback_resolved') });
      await loadAlerts(url.cursor);
      void loadSummary();
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  // KPIs come from the full-collection summary section, never from the current
  // page arrays.
  const kpis = useMemo(() => alertsKpisFromSummary(summary ?? undefined), [summary]);

  const alertsPageIndex = alertsHistory.length + 1;
  const rulesPageIndex = rulesHistory.length + 1;

  /* The URL owns the cursor; these helpers only keep the page counter in step
   * so "page 3 of 3" never claims a position the cursor does not hold. */
  const pushAlertCursor = (cursor: string) => {
    setAlertsHistory((history) => [...history, cursor]);
    url.setCursor(cursor);
  };

  const resetAlertCursor = () => {
    setAlertsHistory([]);
    url.setCursor(undefined);
  };

  const pushRulesCursor = (cursor: string) => {
    setRulesHistory((history) => [...history, cursor]);
    url.setCursor(cursor);
  };

  const resetRulesCursor = () => {
    setRulesHistory([]);
    url.setCursor(undefined);
  };

  return (
    <OperationsPageFrame
      title={t('nf_alerts_title')}
      description={t('nf_alerts_description')}
      icon={<BellRing size={23} />}
      viewSwitch={(
        <div className={styles.viewToggle} role="group" aria-label={t('nf_alerts_view_label')}>
          {ALERT_VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              data-nf-alert-view={option}
              className={view === option ? styles.viewToggleActive : undefined}
              aria-pressed={view === option}
              onClick={() => url.setView(option)}
            >
              {option === 'open'
                ? t('nf_alerts_view_open')
                : option === 'history'
                  ? t('nf_alerts_view_history')
                  : t('nf_alerts_view_rules')}
            </button>
          ))}
        </div>
      )}
      onRefresh={handleRefresh}
      actions={
        view === 'rules' && canConfigure ? (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            <Plus size={16} />
            {t('nf_alerts_add_rule')}
          </button>
        ) : undefined
      }
    >
      {feedback ? (
        <OperationFeedback
          tone={feedback.tone}
          title={t('nf_alerts_operation_result')}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      {summaryLoading && kpis.active === null ? (
        <SkeletonKpiStrip count={4} />
      ) : (
        <section className={styles.kpiStrip} aria-label={t('nf_alerts_kpi_label')}>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_rules')}</span>
            <strong className={styles.kpiValue}>{kpis.rules ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.rules === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_active')}</span>
            <strong className={styles.kpiValue}>{kpis.active ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.active === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_acknowledged')}</span>
            <strong className={styles.kpiValue}>{kpis.acknowledged ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.acknowledged === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
          <article className={styles.kpiCard}>
            <span className={styles.kpiLabel}>{t('nf_alerts_kpi_critical_open')}</span>
            <strong className={styles.kpiValue}>{kpis.criticalOpen ?? '-'}</strong>
            <span className={styles.kpiMeta}>
              {kpis.criticalOpen === null ? (
                <span className={styles.kpiUnavailable}>{t('ops_kpi_unavailable')}</span>
              ) : (
                <span className={styles.kpiScope} title={t('ops_kpi_scope_note')}>{t('ops_kpi_scope_full_collection')}</span>
              )}
            </span>
          </article>
        </section>
      )}

      {view === 'rules' ? (
        <section className="dash-card" data-nf-alert-panel="rules">
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
                value={filters.enabled}
                onChange={(event) => url.setFilter('enabled', event.target.value)}
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
                  url.setFilters({ q: null, enabled: null });
                }}
                disabled={rulesLoading}
              >
                <X size={14} aria-hidden="true" />
                {t('nf_alerts_clear_filters')}
              </button>
            </div>
          </div>
          <p className={styles.semanticNote}>{t('nf_alerts_semantic_note')}</p>

          {rulesError ? (
            <div className={styles.errorWrap}>
              <ErrorState title={t('error')} message={rulesError} retryLabel={t('nf_alerts_retry')} onRetry={() => void loadRules(url.cursor)} />
            </div>
          ) : rulesLoading && rules.length === 0 ? (
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
          {rulesError ? null : rules.length > 0 || rulesPage?.hasMore ? (
            <nav className={styles.pager} aria-label={t('nf_alerts_rules_section')}>
              <span className={styles.pagerSummary} aria-live="polite">
                {t('nf_alerts_pager_rules', { count: rules.length })}
              </span>
              <div className={styles.pagerControls}>
                <button
                  type="button"
                  onClick={resetRulesCursor}
                  disabled={rulesPageIndex === 1 || rulesLoading}
                >
                  {t('ops_pager_first')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextHistory = rulesHistory.slice(0, -1);
                    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
                    setRulesHistory(nextHistory);
                    url.setCursor(prevCursor);
                  }}
                  disabled={rulesPageIndex === 1 || rulesLoading}
                >
                  {t('ops_pager_prev')}
                </button>
                <span className={styles.pageNumber}>{t('ops_pager_page', { page: rulesPageIndex })}</span>
                <button
                  type="button"
                  onClick={() => {
                    const nextCursor = rulesPage?.nextCursor;
                    if (!nextCursor || !rulesPage?.hasMore) return;
                    pushRulesCursor(nextCursor);
                  }}
                  disabled={!rulesPage?.hasMore || !rulesPage?.nextCursor || rulesLoading}
                >
                  {t('ops_pager_next')}
                </button>
              </div>
            </nav>
          ) : null}
        </section>
      ) : (
        <section className="dash-card" data-nf-alert-panel={view}>
          <div className={styles.sectionHead}>
            <h2>
              <BellRing size={16} aria-hidden="true" />
              {view === 'open' ? t('nf_alerts_instances_section') : t('nf_alerts_history_section')}
            </h2>
            <span className={styles.sectionNote}>
              {view === 'open' ? t('nf_alerts_view_open_note') : t('nf_alerts_view_history_note')}
            </span>
          </div>
          <div className={styles.toolbar}>
            <div className={styles.filterGroup}>
              <select
                className="form-input"
                aria-label={t('nf_alerts_filter_severity')}
                value={filters.severity}
                onChange={(event) => url.setFilter('severity', event.target.value)}
              >
                <option value="">{t('nf_alerts_filter_all_severities')}</option>
                {ALERT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {t(`nf_alerts_severity_${severity}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => url.setFilters({ severity: null })}
                disabled={alertsLoading || !filters.severity}
              >
                <X size={14} aria-hidden="true" />
                {t('nf_alerts_clear_filters')}
              </button>
            </div>
          </div>

          {alertsError ? (
            <div className={styles.errorWrap}>
              <ErrorState title={t('error')} message={alertsError} retryLabel={t('nf_alerts_retry')} onRetry={() => void loadAlerts(url.cursor)} />
            </div>
          ) : alertsLoading && alerts.length === 0 ? (
            <LoadingRows columns={7} rows={4} />
          ) : alerts.length === 0 ? (
            <div className={styles.stateWrap}>
              <EmptyState
                icon={<Bell size={44} />}
                title={view === 'open' ? t('nf_alerts_empty_open_title') : t('nf_alerts_empty_history_title')}
                description={view === 'open' ? t('nf_alerts_empty_open_body') : t('nf_alerts_empty_history_body')}
              />
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className="sr-only">
                  {view === 'open' ? t('nf_alerts_instances_caption') : t('nf_alerts_history_caption')}
                </caption>
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
                    <tr key={alert.alertId} data-nf-alert-row={alert.alertId}>
                      <td>
                        <div className={styles.stack}>
                          <button
                            type="button"
                            className={styles.rowButton}
                            onClick={() => setSelectedAlert(alert)}
                          >
                            <strong>{alert.ruleName}</strong>
                          </button>
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
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setSelectedAlert(alert)}
                          >
                            {t('nf_alerts_open_detail')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {alertsError ? null : alerts.length > 0 || alertsPage?.hasMore ? (
            <nav className={styles.pager} aria-label={t('nf_alerts_instances_section')}>
              <span className={styles.pagerSummary} aria-live="polite">
                {t('nf_alerts_pager_alerts', { count: alerts.length })}
              </span>
              <div className={styles.pagerControls}>
                <button
                  type="button"
                  onClick={resetAlertCursor}
                  disabled={alertsPageIndex === 1 || alertsLoading}
                >
                  {t('ops_pager_first')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextHistory = alertsHistory.slice(0, -1);
                    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
                    setAlertsHistory(nextHistory);
                    url.setCursor(prevCursor);
                  }}
                  disabled={alertsPageIndex === 1 || alertsLoading}
                >
                  {t('ops_pager_prev')}
                </button>
                <span className={styles.pageNumber}>{t('ops_pager_page', { page: alertsPageIndex })}</span>
                <button
                  type="button"
                  onClick={() => {
                    const nextCursor = alertsPage?.nextCursor;
                    if (!nextCursor || !alertsPage?.hasMore) return;
                    pushAlertCursor(nextCursor);
                  }}
                  disabled={!alertsPage?.hasMore || !alertsPage?.nextCursor || alertsLoading}
                >
                  {t('ops_pager_next')}
                </button>
              </div>
            </nav>
          ) : null}
        </section>
      )}

      <NfAlertEvidenceDrawer
        alert={selectedAlert}
        canConfigure={canConfigure}
        busy={busyId !== null}
        onClose={() => setSelectedAlert(null)}
        onAcknowledge={(alert) => void handleAcknowledge(alert)}
        onResolve={(alert) => void handleResolve(alert)}
      />

      <NfAlertRuleDialog
        open={dialogOpen}
        meta={meta}
        rule={editingRule}
        onClose={() => setDialogOpen(false)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', message });
          void loadRules(url.cursor);
          void loadSummary();
        }}
        onFormError={(message) => setFeedback({ tone: 'danger', message })}
      />
    </OperationsPageFrame>
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

function alertStateBadge(state: AlertState, t: (key: string) => string): React.ReactElement {
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

function describeLoadError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return err instanceof Error && err.message ? err.message : t('nf_alerts_err_load');
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
