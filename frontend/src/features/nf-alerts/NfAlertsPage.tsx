/*
 * NF alert instances and rule management.
 *
 * Rules are pure observers over NF Health measurement evidence: they never
 * trigger collections and never modify the network. Dedupe windows (cooldown)
 * and recovery-driven clearing are enforced by the evaluation engine; this
 * page only reads results and performs governed mutations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellRing, Check, CheckCheck, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
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
import type {
  Alert,
  AlertRule,
  AlertSeverity,
  NfAlertsMeta,
  PageInfo,
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
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [alertsPage, setAlertsPage] = useState<PageInfo | null>(null);
  const [rulesPage, setRulesPage] = useState<PageInfo | null>(null);
  const [alertsCursorHistory, setAlertsCursorHistory] = useState<string[]>([]);
  const [rulesCursorHistory, setRulesCursorHistory] = useState<string[]>([]);
  const [summary, setSummary] = useState<AlertsSummarySection | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /* UX-1: alert state/severity, the rule query, the rule enabled filter and the
   * alert cursor live in the URL. The rule list keeps its own session cursor
   * until UX-5 splits the queue and the rules into exclusive views. */
  const url = useOperationsUrlState({ keys: ['q', 'state', 'severity', 'enabled'] });
  const ruleSearchQuery = url.filters.q ?? '';
  const ruleEnabledFilter = url.filters.enabled ?? '';
  const alertStateFilter = url.filters.state ?? '';
  const alertSeverityFilter = url.filters.severity ?? '';
  const [ruleSearchInput, setRuleSearchInput] = useState(ruleSearchQuery);

  // Keep the visible rule query in step with the URL (back/forward, shared link).
  useEffect(() => {
    setRuleSearchInput(ruleSearchQuery);
  }, [ruleSearchQuery]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);

  const loadAll = useCallback(async (activeCursor?: string) => {
    setLoading(true);
    setAlertsError(null);
    setRulesError(null);
    setSummaryLoading(true);
    setAlertsCursorHistory([]);
    setRulesCursorHistory([]);
    // Section-split error boundaries: one failing list never blanks the
    // other, and a failed summary section only degrades the KPI strip to
    // explicit unavailable labels, never to page-scoped counts.
    const [metaRes, rulesRes, alertsRes, summaryRes] = await Promise.allSettled([
      fetchNfAlertsMeta(),
      fetchNfAlertRules({
        q: ruleSearchQuery || undefined,
        enabled: ruleEnabledFilter || undefined,
        limit: PAGE_LIMIT,
      }),
      fetchNfAlerts({
        state: alertStateFilter || undefined,
        severity: alertSeverityFilter || undefined,
        cursor: activeCursor,
        limit: PAGE_LIMIT,
      }),
      fetchOperationsSummary(['alerts']),
    ]);
    setMeta(metaRes.status === 'fulfilled' ? metaRes.value : null);
    if (rulesRes.status === 'fulfilled') {
      setRules(rulesRes.value.rules ?? []);
      setRulesPage(rulesRes.value.page ?? null);
    } else {
      setRules([]);
      setRulesPage(null);
      setRulesError(describeLoadError(rulesRes.reason, t));
    }
    if (alertsRes.status === 'fulfilled') {
      setAlerts(alertsRes.value.alerts ?? []);
      setAlertsPage(alertsRes.value.page ?? null);
    } else {
      setAlerts([]);
      setAlertsPage(null);
      setAlertsError(describeLoadError(alertsRes.reason, t));
    }
    setSummary(summaryRes.status === 'fulfilled' ? (summaryRes.value.alerts ?? null) : null);
    setSummaryLoading(false);
    setLoading(false);
  }, [ruleSearchQuery, ruleEnabledFilter, alertStateFilter, alertSeverityFilter, t]);

  // Cursor pager loads refresh exactly one bounded list; the other list and
  // the full-collection summary stay untouched.
  const loadRulesPage = useCallback(async (cursor: string | undefined) => {
    setLoading(true);
    setRulesError(null);
    try {
      const res = await fetchNfAlertRules({
        q: ruleSearchQuery || undefined,
        enabled: ruleEnabledFilter || undefined,
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
      setLoading(false);
    }
  }, [ruleSearchQuery, ruleEnabledFilter, t]);

  const loadAlertsPage = useCallback(async (cursor: string | undefined) => {
    setLoading(true);
    setAlertsError(null);
    try {
      const res = await fetchNfAlerts({
        state: alertStateFilter || undefined,
        severity: alertSeverityFilter || undefined,
        cursor,
        limit: PAGE_LIMIT,
      });
      setAlerts(res.alerts ?? []);
      setAlertsPage(res.page ?? null);
    } catch (err) {
      setAlerts([]);
      setAlertsPage(null);
      setAlertsError(describeLoadError(err, t));
    } finally {
      setLoading(false);
    }
  }, [alertStateFilter, alertSeverityFilter, t]);

  /* Deep links and browser back/forward load the alert page named by the URL
   * cursor. A pager click already fetched that page and is skipped through the
   * ref, so a page step still revalidates only the bounded alert list. */
  const internalCursorRef = useRef<string | undefined>(undefined);
  const internalCursorNavigationRef = useRef(false);
  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      setSummaryLoading(false);
      setAlertsError(t('nf_alerts_err_forbidden'));
      setRulesError(t('nf_alerts_err_forbidden'));
      return;
    }
    if (internalCursorNavigationRef.current && url.cursor === internalCursorRef.current) {
      internalCursorNavigationRef.current = false;
      return;
    }
    void loadAll(url.cursor);
  }, [canRead, loadAll, url.cursor]);

  const handleAlertsFirstPage = () => {
    setAlertsCursorHistory([]);
    internalCursorRef.current = undefined;
    internalCursorNavigationRef.current = url.cursor !== undefined;
    url.setCursor(undefined);
    void loadAlertsPage(undefined);
  };

  const handleAlertsPrevPage = () => {
    if (alertsCursorHistory.length === 0) return;
    const nextHistory = alertsCursorHistory.slice(0, -1);
    setAlertsCursorHistory(nextHistory);
    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
    internalCursorRef.current = prevCursor;
    internalCursorNavigationRef.current = url.cursor !== prevCursor;
    url.setCursor(prevCursor);
    void loadAlertsPage(prevCursor);
  };

  const handleAlertsNextPage = () => {
    const nextCursor = alertsPage?.nextCursor;
    if (!nextCursor || !alertsPage?.hasMore) return;
    setAlertsCursorHistory((history) => [...history, nextCursor]);
    internalCursorRef.current = nextCursor;
    internalCursorNavigationRef.current = url.cursor !== nextCursor;
    url.setCursor(nextCursor);
    void loadAlertsPage(nextCursor);
  };

  const handleRulesFirstPage = () => {
    setRulesCursorHistory([]);
    void loadRulesPage(undefined);
  };

  const handleRulesPrevPage = () => {
    if (rulesCursorHistory.length === 0) return;
    const nextHistory = rulesCursorHistory.slice(0, -1);
    setRulesCursorHistory(nextHistory);
    const prevCursor = nextHistory.length > 0 ? nextHistory[nextHistory.length - 1] : undefined;
    void loadRulesPage(prevCursor);
  };

  const handleRulesNextPage = () => {
    const nextCursor = rulesPage?.nextCursor;
    if (!nextCursor || !rulesPage?.hasMore) return;
    setRulesCursorHistory((history) => [...history, nextCursor]);
    void loadRulesPage(nextCursor);
  };

  const alertsPageIndex = alertsCursorHistory.length + 1;
  const rulesPageIndex = rulesCursorHistory.length + 1;

  const handleRuleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = ruleSearchInput.trim();
    if (next === ruleSearchQuery) {
      void loadAll(url.cursor);
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
      await loadAll(url.cursor);
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
      await loadAll(url.cursor);
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
      await loadAll(url.cursor);
    } catch (err) {
      setFeedback({ tone: 'danger', message: describeMutationError(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  // KPIs come from the full-collection summary section, never from the
  // current page arrays. A page-scoped count must never be presented as a
  // platform total (UX-0 scope/completeness contract).
  const kpis = useMemo(() => alertsKpisFromSummary(summary ?? undefined), [summary]);

  return (
    <OperationsPageFrame
      title={t('nf_alerts_title')}
      description={t('nf_alerts_description')}
      icon={<BellRing size={23} />}
      onRefresh={() => loadAll(url.cursor)}
      actions={
        canConfigure ? (
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

      {loading && summaryLoading && alerts.length === 0 && rules.length === 0 ? (
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
              onChange={(event) => url.setFilter('state', event.target.value)}
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
              onChange={(event) => url.setFilter('severity', event.target.value)}
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
                url.clearFilters();
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('nf_alerts_clear_filters')}
            </button>
          </div>
        </div>

        {alertsError ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={alertsError} retryLabel={t('nf_alerts_retry')} onRetry={() => void loadAll(url.cursor)} />
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
        {alertsError ? null : alerts.length > 0 || alertsPage?.hasMore ? (
          <nav className={styles.pager} aria-label={t('nf_alerts_instances_section')}>
            <span className={styles.pagerSummary} aria-live="polite">
              {t('nf_alerts_pager_alerts', { count: alerts.length })}
            </span>
            <div className={styles.pagerControls}>
              <button
                type="button"
                onClick={handleAlertsFirstPage}
                disabled={alertsPageIndex === 1 || loading}
              >
                {t('ops_pager_first')}
              </button>
              <button
                type="button"
                onClick={handleAlertsPrevPage}
                disabled={alertsPageIndex === 1 || loading}
              >
                {t('ops_pager_prev')}
              </button>
              <span className={styles.pageNumber}>{t('ops_pager_page', { page: alertsPageIndex })}</span>
              <button
                type="button"
                onClick={handleAlertsNextPage}
                disabled={!alertsPage?.hasMore || !alertsPage?.nextCursor || loading}
              >
                {t('ops_pager_next')}
              </button>
            </div>
          </nav>
        ) : null}
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
                url.clearFilters();
              }}
              disabled={loading}
            >
              <X size={14} aria-hidden="true" />
              {t('nf_alerts_clear_filters')}
            </button>
          </div>
        </div>
        <p className={styles.semanticNote}>{t('nf_alerts_semantic_note')}</p>

        {rulesError ? (
          <div className={styles.errorWrap}>
            <ErrorState title={t('error')} message={rulesError} retryLabel={t('nf_alerts_retry')} onRetry={() => void loadAll(url.cursor)} />
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
        {rulesError ? null : rules.length > 0 || rulesPage?.hasMore ? (
          <nav className={styles.pager} aria-label={t('nf_alerts_rules_section')}>
            <span className={styles.pagerSummary} aria-live="polite">
              {t('nf_alerts_pager_rules', { count: rules.length })}
            </span>
            <div className={styles.pagerControls}>
              <button
                type="button"
                onClick={handleRulesFirstPage}
                disabled={rulesPageIndex === 1 || loading}
              >
                {t('ops_pager_first')}
              </button>
              <button
                type="button"
                onClick={handleRulesPrevPage}
                disabled={rulesPageIndex === 1 || loading}
              >
                {t('ops_pager_prev')}
              </button>
              <span className={styles.pageNumber}>{t('ops_pager_page', { page: rulesPageIndex })}</span>
              <button
                type="button"
                onClick={handleRulesNextPage}
                disabled={!rulesPage?.hasMore || !rulesPage?.nextCursor || loading}
              >
                {t('ops_pager_next')}
              </button>
            </div>
          </nav>
        ) : null}
      </section>

      <NfAlertRuleDialog
        open={dialogOpen}
        meta={meta}
        rule={editingRule}
        onClose={() => setDialogOpen(false)}
        onSaved={(message) => {
          setFeedback({ tone: 'success', message });
          void loadAll(url.cursor);
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
