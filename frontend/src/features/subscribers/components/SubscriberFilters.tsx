import { FilterX } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import type { SubscriberFilters as SubscriberFilterState } from '../types';

export type SubscriberPlanOption = {
  plan_id: string;
  name?: string;
  status?: string;
};

interface SubscriberFiltersProps {
  filters: SubscriberFilterState;
  planOptions: SubscriberPlanOption[];
  onChange: (next: SubscriberFilterState) => void;
  onReset: () => void;
}

export function SubscriberFilters({ filters, planOptions, onChange, onReset }: SubscriberFiltersProps) {
  const { t } = useI18n();
  const hasFilters = filters.access !== 'all'
    || filters.contract !== 'all'
    || filters.provisioning !== 'all'
    || filters.balance !== 'all'
    || filters.planId !== '';

  const update = <K extends keyof SubscriberFilterState>(key: K, value: SubscriberFilterState[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="subscriber-filter-bar" aria-label={t('sub_filters_label')}>
      <label className="subscriber-filter-field">
        <span>{t('sub_filter_access')}</span>
        <select
          className="form-input"
          value={filters.access}
          onChange={(event) => update('access', event.target.value as SubscriberFilterState['access'])}
        >
          <option value="all">{t('sub_filter_all')}</option>
          <option value="active">{t('status_active')}</option>
          <option value="restricted">{t('subscriber_summary_restricted')}</option>
        </select>
      </label>

      <label className="subscriber-filter-field">
        <span>{t('sub_contract_status')}</span>
        <select
          className="form-input"
          value={filters.contract}
          onChange={(event) => update('contract', event.target.value as SubscriberFilterState['contract'])}
        >
          <option value="all">{t('sub_filter_all')}</option>
          <option value="active">{t('status_active')}</option>
          <option value="suspended">{t('status_suspended')}</option>
          <option value="terminated">{t('ocs_contract_status_terminated')}</option>
          <option value="none">{t('sub_not_configured')}</option>
        </select>
      </label>

      <label className="subscriber-filter-field">
        <span>{t('sub_provisioning_status')}</span>
        <select
          className="form-input"
          value={filters.provisioning}
          onChange={(event) => update('provisioning', event.target.value as SubscriberFilterState['provisioning'])}
        >
          <option value="all">{t('sub_filter_all')}</option>
          <option value="complete">{t('sub_provisioning_complete')}</option>
          <option value="incomplete">{t('sub_provisioning_incomplete')}</option>
          <option value="missing_contract">{t('sub_provisioning_missing_contract')}</option>
          <option value="missing_balance">{t('sub_provisioning_missing_balance')}</option>
          <option value="missing_plan">{t('sub_provisioning_missing_plan')}</option>
        </select>
      </label>

      <label className="subscriber-filter-field">
        <span>{t('sub_360_tariff_plan')}</span>
        <select
          className="form-input"
          value={filters.planId}
          onChange={(event) => update('planId', event.target.value)}
        >
          <option value="">{t('sub_filter_all')}</option>
          {planOptions.map((plan) => (
            <option key={plan.plan_id} value={plan.plan_id}>
              {plan.name && plan.name !== plan.plan_id ? `${plan.name} (${plan.plan_id})` : plan.plan_id}
            </option>
          ))}
        </select>
      </label>

      <label className="subscriber-filter-field">
        <span>{t('sub_balance_status')}</span>
        <select
          className="form-input"
          value={filters.balance}
          onChange={(event) => update('balance', event.target.value as SubscriberFilterState['balance'])}
        >
          <option value="all">{t('sub_filter_all')}</option>
          <option value="normal">{t('sub_balance_normal')}</option>
          <option value="low">{t('sub_balance_low')}</option>
          <option value="exhausted">{t('sub_balance_exhausted')}</option>
          <option value="missing">{t('sub_not_configured')}</option>
        </select>
      </label>

      {hasFilters && (
        <button type="button" className="btn btn-outline subscriber-filter-reset" onClick={onReset}>
          <FilterX size={15} /> {t('sub_filter_reset')}
        </button>
      )}
    </div>
  );
}
