/*
 * Tariff plan detail (`/ocs/tariffs/:planId`).
 *
 * The historical page rendered four summary cards: identifier, status, a byte
 * count and a rule *number*. Everything the endpoint already returned stayed
 * invisible, including the rules themselves, the governance history, the bound
 * contracts and the JSON export.
 *
 * This page is read-only by policy. Tariff rule writes, plan import and plan
 * migration are disabled on the server (`OCS_TARIFF_RULE_*_NOT_SUPPORTED`,
 * `OCS_PLAN_MIGRATION_NOT_SUPPORTED`), so the surface states that rule
 * maintenance belongs to the charging plane instead of offering controls that
 * could only fail. What it does offer is everything the read side supports:
 * rule inventory with conflicts, the bound contracts, and the governance trail.
 */
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Download, FileText, History, ListChecks, Pencil, Users } from 'lucide-react';
import PageHeader from '../../ui/PageHeader';
import RefreshButton from '../../ui/RefreshButton';
import OcsStatusBadge from '../common/OcsStatusBadge';
import OcsDetailState from '../common/OcsDetailState';
import TariffPlanModal from './TariffPlanModal';
import { useRead } from '../../../lib/api/use-read';
import { hasPermission } from '../../../lib/permissions';
import { useAuth } from '../../../providers/AuthProvider';
import { useI18n } from '../../../providers/I18nProvider';
import { toTariffDetailViewModel, type TariffPlanViewModel } from '../../../features/ocs/ocs-view-models';
import { downloadTariffPlanExport } from '../../../features/ocs/ocs-export';
import { formatOcsBytes, formatOcsRuleQuota, formatOcsSeconds, formatOcsTime } from '../../../features/ocs/ocs-format';
import { asArray, asNumber, asRecord, asString } from '../../../lib/api/envelope';
import { resolveReturnTo } from '../../../lib/return-to';

interface OcsTariffDetailProps {
  planId: string;
}

type RuleRow = {
  ruleId: string;
  apn: string;
  chargingType: string;
  unit: string;
  quotaPerGrant: number | null;
  validityTime: number | null;
  priority: number | null;
  status: string;
};

type HistoryRow = {
  id: string;
  action: string;
  actor: string;
  result: string;
  createdAt: string;
};

type BoundRow = {
  imsi: string;
  msisdn: string;
  status: string;
  updatedAt: string;
};

function toRuleRows(payload: unknown): RuleRow[] {
  const raw = asArray(asRecord(payload).rules) ?? [];
  return raw
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      ruleId: asString(entry.rule_id) ?? asString(entry.ruleId) ?? '\u2014',
      apn: asString(entry.apn) ?? '\u2014',
      chargingType: asString(entry.charging_type) ?? asString(entry.chargingType) ?? '\u2014',
      unit: asString(entry.unit) ?? '\u2014',
      quotaPerGrant: asNumber(entry.quota_per_grant) ?? asNumber(entry.quotaPerGrant),
      validityTime: asNumber(entry.validity_time) ?? asNumber(entry.validityTime),
      priority: asNumber(entry.priority),
      status: asString(entry.status) ?? '\u2014',
    }));
}

export default function OcsTariffDetail({ planId }: OcsTariffDetailProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canWrite = hasPermission(user, 'ocs.tariff.write');

  const [editOpen, setEditOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const encoded = encodeURIComponent(planId);
  const { data, error, isLoading, mutate: refresh } = useRead<unknown>(`/api/tariff-plans/${encoded}`);
  const { data: rulesData, error: rulesError, mutate: refreshRules } = useRead<unknown>(`/api/tariff-plans/${encoded}/rules`);
  const { data: subsData, error: subsError, mutate: refreshSubs } = useRead<unknown>(`/api/tariff-plans/${encoded}/subscribers`);
  const { data: opsData, error: opsError, mutate: refreshOps } = useRead<unknown>(`/api/tariff-plans/${encoded}/operations`);

  const plan: TariffPlanViewModel | null = toTariffDetailViewModel(data);
  const rules = toRuleRows(rulesData);
  const conflicts = asArray(asRecord(rulesData).conflicts) ?? [];

  const subsRecord = asRecord(subsData);
  const boundTotal = asNumber(subsRecord.total) ?? null;
  const boundRows: BoundRow[] = (asArray(subsRecord.subscribers) ?? [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      imsi: asString(entry.imsi) ?? '',
      msisdn: asString(entry.msisdn) ?? '',
      status: asString(entry.status) ?? '',
      updatedAt: asString(entry.updated_at) ?? asString(entry.updatedAt) ?? '',
    }));

  const history: HistoryRow[] = (asArray(asRecord(opsData).history) ?? [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      id: asString(entry.id) ?? '',
      action: asString(entry.action) ?? '',
      actor: asString(entry.actor) ?? '',
      result: asString(entry.result) ?? '',
      createdAt: asString(entry.createdAt) ?? asString(entry.created_at) ?? '',
    }));

  const handleExport = async () => {
    setFeedback(null);
    try {
      await downloadTariffPlanExport(planId);
    } catch (failure) {
      setFeedback({
        type: 'error',
        message: failure instanceof Error ? failure.message : t('ocs_tariff_action_failed'),
      });
    }
  };

  const location = useLocation();
  const returnTo = resolveReturnTo(location.search, '/ocs/tariffs', ['/ocs/tariffs']);
  const backTo = { to: returnTo, label: t('ocs_back_to_list') };

  if (isLoading && !data) {
    return (
      <div className="ocs-container">
        <OcsDetailState kind="loading" />
      </div>
    );
  }

  if (error && !plan) {
    const status = (error as { status?: number }).status ?? 0;
    if (status === 403) {
      return <div className="ocs-container"><OcsDetailState kind="forbidden" backTo={backTo} /></div>;
    }
    if (status === 404) {
      return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
    }
    return (
      <div className="ocs-container">
        <OcsDetailState
          kind="error"
          detail={error.message}
          onRetry={() => void refresh()}
          backTo={backTo}
        />
      </div>
    );
  }

  if (!plan) {
    return <div className="ocs-container"><OcsDetailState kind="notFound" backTo={backTo} /></div>;
  }

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={t('nav_ocs_tariffs')}
        title={plan.name || plan.planId || ''}
        description={plan.description || ''}
        actions={
          <div className="ocs-header-actions">
            <Link to="/ocs/tariffs" className="ocs-btn ocs-btn-secondary">
              <ArrowLeft size={14} aria-hidden="true" /> {t('ocs_back_to_list')}
            </Link>
            <RefreshButton loading={isLoading} onClick={() => void refresh()} label={t('refresh')} className="ocs-btn" />
            <button type="button" className="ocs-btn ocs-btn-secondary" onClick={() => void handleExport()}>
              <Download size={14} aria-hidden="true" /> <span>{t('ocs_tariff_export')}</span>
            </button>
            {canWrite && (
              <button type="button" className="ocs-btn ocs-btn-primary" onClick={() => setEditOpen(true)}>
                <Pencil size={14} aria-hidden="true" /> <span>{t('ocs_tariff_edit')}</span>
              </button>
            )}
          </div>
        }
      />

      {feedback && (
        <div className={feedback.type === 'success' ? 'ocs-feedback-success ocs-feedback-spaced' : 'ocs-feedback-error ocs-feedback-spaced'} role={feedback.type === 'error' ? 'alert' : 'status'}>
          <span>{feedback.message}</span>
        </div>
      )}

      <div className="ocs-detail-grid">
        <div className="ocs-detail-section">
          <h2><FileText size={16} aria-hidden="true" /> {t('ocs_tariff_detail_basic')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_plan_id')}</span>
              <span className="ocs-detail-value ocs-mono">{plan.planId ?? '\u2014'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_name')}</span>
              <span className="ocs-detail-value">{plan.name ?? '\u2014'}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_col_status')}</span>
              <span className="ocs-detail-value">
                <span className="ocs-status-cluster">
                  <OcsStatusBadge status={plan.status ?? ''} />
                  {plan.isDefault ? <span className="ocs-default-badge">{t('ocs_tariff_default_badge')}</span> : null}
                </span>
              </span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_created')}</span>
              <span className="ocs-detail-value">{formatOcsTime(plan.createdAt)}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h2><ListChecks size={16} aria-hidden="true" /> {t('ocs_tariff_detail_quota')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_data_quota')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsBytes(plan.quotaPerGrant)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_volume_threshold')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsBytes(plan.volumeThreshold)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_validity_time')}</span>
              <span className="ocs-detail-value ocs-mono">{formatOcsSeconds(plan.validityTime)}</span>
            </div>
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_rules_count')}</span>
              <span className="ocs-detail-value">{rulesError ? '\u2014' : rules.length}</span>
            </div>
          </div>
        </div>

        <div className="ocs-detail-section">
          <h2><Users size={16} aria-hidden="true" /> {t('ocs_tariff_bound_title')}</h2>
          <div className="ocs-detail-fields">
            <div className="ocs-detail-field">
              <span className="ocs-detail-label">{t('ocs_tariff_detail_bound_count')}</span>
              <span className="ocs-detail-value">{subsError ? '\u2014' : boundTotal ?? '\u2014'}</span>
            </div>
          </div>
          <Link className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto" to={`/ocs/contracts?plan=${encoded}`}>
            {t('ocs_tariff_bound_view_all')}
          </Link>
        </div>
      </div>

      <section className="ocs-detail-section ocs-detail-section-full">
        <h2><ListChecks size={16} aria-hidden="true" /> {t('ocs_tariff_rules_title')}</h2>
        {rulesError ? (
          <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
            <span>{t('ocs_detail_load_failed')}</span>
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
              onClick={() => { void refreshRules(); }}
            >
              {t('retry')}
            </button>
          </div>
        ) : (
          <>
        {conflicts.length > 0 && (
          <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
            <span>{t('ocs_tariff_rule_conflicts', { count: conflicts.length })}</span>
          </div>
        )}
        {rules.length === 0 ? (
          <p className="ocs-empty">{t('ocs_tariff_rules_empty')}</p>
        ) : (
          <div className="ocs-table-wrap">
            <table className="ocs-table">
              <caption className="sr-only">{t('ocs_tariff_rules_title')}</caption>
              <thead>
                <tr>
                  <th data-column-priority="important">{t('ocs_tariff_rule_col_id')}</th>
                  <th data-column-priority="important">{t('ocs_tariff_rule_col_apn')}</th>
                  <th data-column-priority="supplementary">{t('ocs_tariff_rule_col_charging')}</th>
                  <th data-column-priority="supplementary">{t('ocs_tariff_rule_col_unit')}</th>
                  <th data-column-priority="important">{t('ocs_tariff_rule_col_quota')}</th>
                  <th data-column-priority="supplementary">{t('ocs_tariff_rule_col_validity')}</th>
                  <th data-column-priority="supplementary">{t('ocs_tariff_rule_col_priority')}</th>
                  <th data-column-priority="essential">{t('ocs_tariff_rule_col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, index) => (
                  <tr key={rule.ruleId === '\u2014' ? `rule-${index}` : rule.ruleId}>
                    <td data-label={t('ocs_tariff_rule_col_id')} data-column-priority="important" className="ocs-mono">{rule.ruleId}</td>
                    <td data-label={t('ocs_tariff_rule_col_apn')} data-column-priority="important" className="ocs-mono">{rule.apn}</td>
                    <td data-label={t('ocs_tariff_rule_col_charging')} data-column-priority="supplementary">{rule.chargingType}</td>
                    <td data-label={t('ocs_tariff_rule_col_unit')} data-column-priority="supplementary">{rule.unit}</td>
                    <td data-label={t('ocs_tariff_rule_col_quota')} data-column-priority="important" className="ocs-mono">{formatOcsRuleQuota(rule.quotaPerGrant, rule.unit)}</td>
                    <td data-label={t('ocs_tariff_rule_col_validity')} data-column-priority="supplementary" className="ocs-mono">{formatOcsSeconds(rule.validityTime)}</td>
                    <td data-label={t('ocs_tariff_rule_col_priority')} data-column-priority="supplementary" className="ocs-mono">{rule.priority ?? '\u2014'}</td>
                    <td data-label={t('ocs_tariff_rule_col_status')} data-column-priority="essential"><OcsStatusBadge status={rule.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </>
        )}
      </section>

      <section className="ocs-detail-section ocs-detail-section-full">
        <h2><Users size={16} aria-hidden="true" /> {t('ocs_tariff_bound_title')}</h2>
        {subsError ? (
          <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
            <span>{t('ocs_detail_load_failed')}</span>
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
              onClick={() => { void refreshSubs(); }}
            >
              {t('retry')}
            </button>
          </div>
        ) : boundRows.length === 0 ? (
          <p className="ocs-empty">{t('ocs_tariff_bound_empty')}</p>
        ) : (
          <>
            <p className="ocs-detail-hint">{t('ocs_tariff_bound_total', { count: boundTotal ?? boundRows.length })}</p>
            <div className="ocs-table-wrap">
              <table className="ocs-table">
                <caption className="sr-only">{t('ocs_tariff_bound_title')}</caption>
                <thead>
                  <tr>
                    <th data-column-priority="essential">IMSI</th>
                    <th data-column-priority="supplementary">{t('ocs_contract_col_msisdn')}</th>
                    <th data-column-priority="essential">{t('ocs_tariff_rule_col_status')}</th>
                    <th data-column-priority="supplementary">{t('ocs_contract_col_last_change')}</th>
                  </tr>
                </thead>
                <tbody>
                  {boundRows.map((row) => (
                    <tr key={row.imsi}>
                      <td data-label="IMSI" data-column-priority="essential" className="ocs-mono">
                        <Link className="ocs-link" to={`/ocs/contracts/${encodeURIComponent(row.imsi)}`}>{row.imsi}</Link>
                      </td>
                      <td data-label={t('ocs_contract_col_msisdn')} data-column-priority="supplementary">{row.msisdn || '\u2014'}</td>
                      <td data-label={t('ocs_tariff_rule_col_status')} data-column-priority="essential"><OcsStatusBadge status={row.status} /></td>
                      <td data-label={t('ocs_contract_col_last_change')} data-column-priority="supplementary" className="ocs-time-cell">{formatOcsTime(row.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="ocs-detail-section ocs-detail-section-full">
        <h2><History size={16} aria-hidden="true" /> {t('ocs_tariff_history_title')}</h2>
        {opsError ? (
          <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">
            <span>{t('ocs_detail_load_failed')}</span>
            <button
              type="button"
              className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto"
              onClick={() => { void refreshOps(); }}
            >
              {t('retry')}
            </button>
          </div>
        ) : history.length === 0 ? (
          <p className="ocs-empty">{t('ocs_tariff_history_empty')}</p>
        ) : (
          <div className="ocs-table-wrap">
            <table className="ocs-table">
              <caption className="sr-only">{t('ocs_tariff_history_title')}</caption>
              <thead>
                <tr>
                  <th data-column-priority="essential">{t('ocs_tariff_history_col_action')}</th>
                  <th data-column-priority="important">{t('ocs_tariff_history_col_actor')}</th>
                  <th data-column-priority="supplementary">{t('ocs_tariff_history_col_result')}</th>
                  <th data-column-priority="supplementary">{t('ocs_tariff_history_col_time')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id || `${row.action}-${row.createdAt}`}>
                    <td data-label={t('ocs_tariff_history_col_action')} data-column-priority="essential" className="ocs-mono">{row.action}</td>
                    <td data-label={t('ocs_tariff_history_col_actor')} data-column-priority="important">{row.actor || '\u2014'}</td>
                    <td data-label={t('ocs_tariff_history_col_result')} data-column-priority="supplementary">{row.result || '\u2014'}</td>
                    <td data-label={t('ocs_tariff_history_col_time')} data-column-priority="supplementary" className="ocs-time-cell">{formatOcsTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editOpen && (
        <TariffPlanModal
          isOpen={editOpen}
          plan={plan}
          onClose={() => setEditOpen(false)}
          onSuccess={(result) => {
            setEditOpen(false);
            void refresh();
            setFeedback({ type: 'success', message: result.message });
          }}
        />
      )}
    </div>
  );
}
