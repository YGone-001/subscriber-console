/*
 * Provision a billing contract for an existing subscriber.
 *
 * The historical POST /api/ocs/subscribers was an upsert with an implicit
 * default plan and a client-chosen status. This dialog only drives the
 * insert-only contract-provisioning flow: the subscriber identity supplies the
 * IMSI and primary MSISDN, the plan is explicit, the contract is always active,
 * and only the quota buckets the operator confirms are written.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { useRead } from '../../../lib/api/use-read';
import { getJson } from '../../../lib/api/read-client';
import { postJson, MutationApiError } from '../../../lib/api/mutation-client';
import { useI18n } from '../../../providers/I18nProvider';
import {
  formatBytes,
  formatEvents,
  formatSeconds,
  parseBytes,
  parseEvents,
  parseSeconds,
} from '../../../lib/unitParser';
import {
  toTariffListViewModel,
  type TariffPlanViewModel,
} from '../../../features/ocs/ocs-view-models';

type SubscriberLookup = {
  imsi?: string;
  sub4G?: { msisdnList?: Array<{ msisdn?: string }>; profile_name?: string };
  ocsImsi?: unknown;
};

type QuotaDraft = {
  dataTotal: string;
  dataBalance: string;
  voiceTotal: string;
  voiceBalance: string;
  smsTotal: string;
  smsBalance: string;
};

type PlanRule = {
  charging_type?: string;
  unit?: string;
  quota_per_grant?: number;
};

type PlanDetail = {
  quota_per_grant?: number;
  volume_threshold?: number;
  rules?: PlanRule[];
};

const EMPTY_QUOTA: QuotaDraft = {
  dataTotal: '',
  dataBalance: '',
  voiceTotal: '',
  voiceBalance: '',
  smsTotal: '',
  smsBalance: '',
};

const BYTE_INPUT = /^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB)?$/i;
const TIME_INPUT = /^\d+(?:\.\d+)?\s*[smhd]?$/i;
const EVENT_INPUT = /^\d+$/;

function parseStrictQuota(raw: string, pattern: RegExp, parser: (value: string) => number): number | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (!pattern.test(value)) throw new Error('invalid');
  return parser(value);
}

function primaryMsisdn(lookup: SubscriberLookup | null): string {
  const list = lookup?.sub4G?.msisdnList;
  if (!Array.isArray(list) || list.length === 0) return '';
  return String(list[0]?.msisdn ?? '').trim();
}

export type CreateContractDialogProps = {
  open: boolean;
  initialImsi?: string;
  onClose: () => void;
  onCreated: (imsi: string, balanceAdopted: boolean) => void;
};

export default function CreateContractDialog({ open, initialImsi, onClose, onCreated }: CreateContractDialogProps) {
  const { t } = useI18n();
  const { data: tariffsData } = useRead<unknown>(open ? '/api/tariff-plans' : null);

  const [imsi, setImsi] = useState('');
  const [subscriber, setSubscriber] = useState<SubscriberLookup | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [planId, setPlanId] = useState('');
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [quota, setQuota] = useState<QuotaDraft>(EMPTY_QUOTA);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plans = useMemo<TariffPlanViewModel[]>(() => toTariffListViewModel(tariffsData).records, [tariffsData]);
  const activePlans = useMemo(
    () => plans.filter((plan) => plan.status === 'active' && plan.planId).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [plans],
  );
  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.planId === planId) ?? null,
    [plans, planId],
  );

  const reset = useCallback(() => {
    setImsi(initialImsi ?? '');
    setSubscriber(null);
    setPlanId('');
    setPlanDetail(null);
    setQuota(EMPTY_QUOTA);
    setReason('');
    setBusy(false);
    setError(null);
  }, [initialImsi]);

  const loadSubscriber = useCallback(async (value: string) => {
    const target = value.trim();
    if (!/^\d{15}$/.test(target)) {
      setSubscriber(null);
      setError(t('ocs_contract_create_imsi_hint'));
      return;
    }
    setLookupLoading(true);
    setError(null);
    try {
      const data = await getJson<SubscriberLookup>(`/api/subscribers/${encodeURIComponent(target)}`);
      if (data.ocsImsi) {
        setSubscriber(null);
        setError(t('ocs_contract_create_contract_exists', { imsi: target }));
        return;
      }
      setSubscriber(data);
    } catch (failure) {
      setSubscriber(null);
      const status = failure instanceof Error && 'status' in failure ? Number((failure as { status?: number }).status) : 0;
      setError(status === 404
        ? t('ocs_contract_create_subscriber_missing', { imsi: target })
        : t('ocs_contract_create_lookup_failed'));
    } finally {
      setLookupLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    reset();
    if (initialImsi && /^\d{15}$/.test(initialImsi)) {
      void loadSubscriber(initialImsi);
    }
  }, [open, initialImsi, reset, loadSubscriber]);

  useEffect(() => {
    if (!open || !planId) {
      setPlanDetail(null);
      return;
    }
    let cancelled = false;
    getJson<Record<string, unknown>>(`/api/tariff-plans/${encodeURIComponent(planId)}`)
      .then((data) => {
        if (cancelled) return;
        const plan = data.plan && typeof data.plan === 'object' ? (data.plan as PlanDetail) : null;
        setPlanDetail(plan);
        if (!plan) {
          setQuota(EMPTY_QUOTA);
          return;
        }
        const dataQuota = Number(plan.quota_per_grant);
        const rules = Array.isArray(plan.rules) ? plan.rules : [];
        const voiceRule = rules.find((rule) => rule?.charging_type === 'voice_time');
        const smsRule = rules.find((rule) => rule?.charging_type === 'sms_event' || rule?.unit === 'events');
        const voiceQuota = Number(voiceRule?.quota_per_grant);
        const smsQuota = Number(smsRule?.quota_per_grant);
        setQuota({
          dataTotal: Number.isFinite(dataQuota) && dataQuota > 0 ? formatBytes(dataQuota) : '',
          dataBalance: Number.isFinite(dataQuota) && dataQuota > 0 ? formatBytes(dataQuota) : '',
          voiceTotal: Number.isFinite(voiceQuota) && voiceQuota > 0 ? formatSeconds(voiceQuota) : '',
          voiceBalance: Number.isFinite(voiceQuota) && voiceQuota > 0 ? formatSeconds(voiceQuota) : '',
          smsTotal: Number.isFinite(smsQuota) && smsQuota > 0 ? formatEvents(smsQuota) : '',
          smsBalance: Number.isFinite(smsQuota) && smsQuota > 0 ? formatEvents(smsQuota) : '',
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPlanDetail(null);
          setQuota(EMPTY_QUOTA);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, planId]);

  const submit = async () => {
    if (busy) return;
    const target = imsi.trim();
    if (!subscriber) {
      setError(t('ocs_contract_create_imsi_hint'));
      return;
    }
    if (!planId) {
      setError(t('ocs_contract_create_plan_required'));
      return;
    }
    if (reason.trim().length < 3) {
      setError(t('ocs_contract_create_err_reason'));
      return;
    }

    const ocsTraffic: Record<string, number> = {};
    try {
      const dataTotal = parseStrictQuota(quota.dataTotal, BYTE_INPUT, parseBytes);
      const dataBalance = parseStrictQuota(quota.dataBalance, BYTE_INPUT, parseBytes);
      const voiceTotal = parseStrictQuota(quota.voiceTotal, TIME_INPUT, parseSeconds);
      const voiceBalance = parseStrictQuota(quota.voiceBalance, TIME_INPUT, parseSeconds);
      const smsTotal = parseStrictQuota(quota.smsTotal, EVENT_INPUT, parseEvents);
      const smsBalance = parseStrictQuota(quota.smsBalance, EVENT_INPUT, parseEvents);
      if (dataTotal !== undefined) ocsTraffic.traffic_total = dataTotal;
      if (dataBalance !== undefined) ocsTraffic.traffic_balance = dataBalance;
      if (voiceTotal !== undefined) ocsTraffic.voice_total = voiceTotal;
      if (voiceBalance !== undefined) ocsTraffic.voice_balance = voiceBalance;
      if (smsTotal !== undefined) ocsTraffic.sms_total = smsTotal;
      if (smsBalance !== undefined) ocsTraffic.sms_balance = smsBalance;
    } catch {
      setError(t('ocs_contract_create_quota_invalid'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const msisdn = primaryMsisdn(subscriber);
      const result = await postJson<{ balanceAdopted?: boolean }>('/api/ocs/subscribers', {
        imsi: target,
        plan_id: planId,
        ...(msisdn ? { msisdn } : {}),
        ...(Object.keys(ocsTraffic).length > 0 ? { ocsTraffic } : {}),
        reason: reason.trim(),
      });
      onCreated(target, Boolean(result?.balanceAdopted));
    } catch (failure) {
      const code = failure instanceof MutationApiError ? failure.code : undefined;
      if (code === 'OCS_CONTRACT_RETAINED') setError(t('ocs_contract_create_err_retained', { imsi: target }));
      else if (code === 'OCS_CONTRACT_EXISTS' || code === 'OCS_SUBSCRIBER_EXISTS') setError(t('ocs_contract_create_err_exists', { imsi: target }));
      else if (code === 'SUBSCRIBER_NOT_FOUND') setError(t('ocs_contract_create_subscriber_missing', { imsi: target }));
      else if (code === 'OCS_BALANCE_PLAN_MISMATCH') setError(t('ocs_contract_create_err_balance_plan'));
      else if (code === 'OCS_BALANCE_STATUS_INCONSISTENT') setError(t('ocs_contract_create_err_balance_status'));
      else if (code === 'OCS_TARIFF_NOT_FOUND' || code === 'OCS_PLAN_NOT_FOUND') setError(t('tariff_plan_err_not_found'));
      else if (code === 'OCS_TARIFF_DISABLED' || code === 'OCS_PLAN_DISABLED') setError(t('tariff_plan_err_disabled'));
      else if (code === 'MSISDN_MISMATCH') setError(t('ocs_contract_create_err_msisdn'));
      else setError(failure instanceof Error ? failure.message : t('ocs_contract_create_err_generic'));
    } finally {
      setBusy(false);
    }
  };

  const balanceEffect = t('ocs_contract_create_preview', {
    balance: t('ocs_contract_create_balance_created'),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="ocs-dialog"
      overlayClassName="ocs-dialog-overlay"
      labelledBy="contract-create-title"
    >
      <div className="ocs-dialog-header">
        <h3 id="contract-create-title">{t('ocs_contract_create_title')}</h3>
      </div>
      <p className="ocs-dialog-copy">{t('ocs_contract_create_desc')}</p>

      {error ? <div className="ocs-feedback-error ocs-feedback-spaced" role="alert">{error}</div> : null}

      <div className="ocs-form-group">
        <label htmlFor="contract-create-imsi" className="ocs-form-label">
          {t('ocs_contract_create_imsi')}
        </label>
        <div className="ocs-contract-create-lookup">
          <input
            id="contract-create-imsi"
            className="ocs-form-input ocs-mono"
            inputMode="numeric"
            maxLength={15}
            value={imsi}
            onChange={(event) => setImsi(event.target.value.replace(/\D/g, '').slice(0, 15))}
            onBlur={() => { if (imsi.trim()) void loadSubscriber(imsi); }}
            placeholder="15-digit IMSI"
            disabled={busy}
          />
          <button
            type="button"
            className="ocs-btn ocs-btn-secondary"
            onClick={() => void loadSubscriber(imsi)}
            disabled={busy || lookupLoading || !/^\d{15}$/.test(imsi.trim())}
          >
            {lookupLoading ? t('loading') : t('ocs_contract_create_lookup')}
          </button>
        </div>
        <span className="ocs-form-hint">{t('ocs_contract_create_imsi_hint')}</span>
        {subscriber ? (
          <div className="ocs-contract-create-subscriber">
            <span className="ocs-detail-label">IMSI</span>
            <span className="ocs-mono">{subscriber.imsi || imsi}</span>
            <span className="ocs-detail-label">MSISDN</span>
            <span className="ocs-mono">{primaryMsisdn(subscriber) || t('sub_not_configured')}</span>
            {subscriber.sub4G?.profile_name ? (
              <>
                <span className="ocs-detail-label">{t('ocs_contract_create_template')}</span>
                <span>{subscriber.sub4G.profile_name}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="ocs-form-group">
        <label htmlFor="contract-create-plan" className="ocs-form-label">
          {t('ocs_filter_plan')}
        </label>
        <select
          id="contract-create-plan"
          className="ocs-select"
          value={planId}
          onChange={(event) => setPlanId(event.target.value)}
          disabled={busy}
        >
          <option value="">{t('ocs_contract_create_plan_placeholder')}</option>
          {activePlans.map((plan) => (
            <option key={plan.planId} value={plan.planId ?? ''}>
              {plan.name || plan.planId} · {plan.quotaPerGrant ? formatBytes(plan.quotaPerGrant) : t('sub_not_configured')}
            </option>
          ))}
        </select>
        {selectedPlan ? (
          <span className="ocs-form-hint">
            {t('ocs_tariff_col_quota')}: {selectedPlan.quotaPerGrant ? formatBytes(selectedPlan.quotaPerGrant) : t('sub_not_configured')}
            {selectedPlan.validityTime ? ` · ${formatSeconds(selectedPlan.validityTime)}` : ''}
            {planDetail?.volume_threshold ? ` · ${t('ocs_contract_create_threshold')}: ${formatBytes(Number(planDetail.volume_threshold))}` : ''}
          </span>
        ) : null}
      </div>

      <fieldset className="ocs-form-group ocs-contract-create-quota">
        <legend className="ocs-form-label">{t('ocs_contract_create_quota')}</legend>
        <p className="ocs-form-hint">{t('ocs_contract_create_quota_hint')}</p>
        <div className="ocs-form-grid">
          <label className="ocs-form-label" htmlFor="contract-create-data-total">
            {t('ocs_contract_create_data_total')}
            <input id="contract-create-data-total" className="ocs-form-input ocs-mono" value={quota.dataTotal}
              onChange={(event) => setQuota((current) => ({ ...current, dataTotal: event.target.value }))}
              placeholder={t('ocs_contract_create_placeholder_bytes')} disabled={busy} />
          </label>
          <label className="ocs-form-label" htmlFor="contract-create-data-balance">
            {t('ocs_contract_create_data_balance')}
            <input id="contract-create-data-balance" className="ocs-form-input ocs-mono" value={quota.dataBalance}
              onChange={(event) => setQuota((current) => ({ ...current, dataBalance: event.target.value }))}
              placeholder={t('ocs_contract_create_placeholder_bytes')} disabled={busy} />
          </label>
          <label className="ocs-form-label" htmlFor="contract-create-voice-total">
            {t('ocs_contract_create_voice_total')}
            <input id="contract-create-voice-total" className="ocs-form-input ocs-mono" value={quota.voiceTotal}
              onChange={(event) => setQuota((current) => ({ ...current, voiceTotal: event.target.value }))}
              placeholder={t('ocs_contract_create_placeholder_time')} disabled={busy} />
          </label>
          <label className="ocs-form-label" htmlFor="contract-create-voice-balance">
            {t('ocs_contract_create_voice_balance')}
            <input id="contract-create-voice-balance" className="ocs-form-input ocs-mono" value={quota.voiceBalance}
              onChange={(event) => setQuota((current) => ({ ...current, voiceBalance: event.target.value }))}
              placeholder={t('ocs_contract_create_placeholder_time')} disabled={busy} />
          </label>
          <label className="ocs-form-label" htmlFor="contract-create-sms-total">
            {t('ocs_contract_create_sms_total')}
            <input id="contract-create-sms-total" className="ocs-form-input ocs-mono" value={quota.smsTotal}
              onChange={(event) => setQuota((current) => ({ ...current, smsTotal: event.target.value }))}
              placeholder={t('ocs_contract_create_placeholder_events')} disabled={busy} />
          </label>
          <label className="ocs-form-label" htmlFor="contract-create-sms-balance">
            {t('ocs_contract_create_sms_balance')}
            <input id="contract-create-sms-balance" className="ocs-form-input ocs-mono" value={quota.smsBalance}
              onChange={(event) => setQuota((current) => ({ ...current, smsBalance: event.target.value }))}
              placeholder={t('ocs_contract_create_placeholder_events')} disabled={busy} />
          </label>
        </div>
      </fieldset>

      <div className="ocs-form-group">
        <label htmlFor="contract-create-reason" className="ocs-form-label">
          {t('ocs_contract_create_reason')}
        </label>
        <textarea
          id="contract-create-reason"
          className="ocs-form-textarea"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('ocs_contract_create_reason_hint')}
          disabled={busy}
        />
      </div>

      <p className="ocs-dialog-copy">{balanceEffect}</p>

      <div className="ocs-dialog-actions">
        <button type="button" className="ocs-btn ocs-btn-secondary" onClick={onClose} disabled={busy}>
          {t('cancel')}
        </button>
        <button type="button" className="ocs-btn ocs-btn-primary" onClick={() => void submit()} disabled={busy || !subscriber}>
          {busy ? t('saving') : t('ocs_contract_create_submit')}
        </button>
      </div>
    </Dialog>
  );
}
