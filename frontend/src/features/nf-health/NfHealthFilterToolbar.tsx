/*
 * NF Health filter toolbar.
 *
 * Presentation only: every control reports an intent and the page decides the
 * canonical URL transition and the request it triggers. The toolbar owns no URL
 * state of its own, so there is exactly one registry of list state.
 *
 * The search box is a draft plus a submit, not a live query. The page keeps the
 * committed term so a late self-initiated URL echo cannot overwrite a newer
 * draft, and a submit uses the term the operator actually typed last.
 */
import { Search, X } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { OPERATIONAL_DOMAINS } from '../operations/operational-model';
import {
  HEALTH_COLLECTION_OUTCOMES,
  HEALTH_FRESHNESS_STATES,
  HEALTH_LAYER_FILTERS,
  HEALTH_OVERALL_STATES,
  HEALTH_SORTS,
  type HealthFilters,
} from './nf-health-filters';
import styles from '../../styles/modules/nf-health.module.css';

/** The URL keys this toolbar can change. The page owns what they mean. */
export type HealthToolbarFilterKey =
  | 'enabled'
  | 'domain'
  | 'state'
  | 'layers'
  | 'freshness'
  | 'collection'
  | 'sort';

export type NfHealthFilterToolbarProps = {
  filters: HealthFilters;
  /** Current draft of the search box, owned by the page. */
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  onSearchSubmit: (event: React.FormEvent) => void;
  onFilterChange: (key: HealthToolbarFilterKey, value: string) => void;
  onClearFilters: () => void;
  /** True while a read is in flight; disables the destructive clear action. */
  disabled: boolean;
  /** True when at least one narrowing filter is active. */
  filtersActive: boolean;
};

export function NfHealthFilterToolbar({
  filters,
  searchInput,
  onSearchInputChange,
  onSearchSubmit,
  onFilterChange,
  onClearFilters,
  disabled,
  filtersActive,
}: NfHealthFilterToolbarProps) {
  const { t } = useI18n();
  return (
    <div className={styles.toolbar}>
      <form className={styles.search} onSubmit={onSearchSubmit} role="search">
        <Search size={16} className={styles.searchIcon} aria-hidden="true" />
        <input
          type="search"
          value={searchInput}
          onChange={(event) => onSearchInputChange(event.target.value)}
          placeholder={t('nf_health_search_placeholder')}
          aria-label={t('nf_health_search_placeholder')}
        />
        <button type="submit" className="btn btn-secondary">
          {t('search')}
        </button>
      </form>
      <div className={styles.filterGroup}>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_enabled')}
          value={filters.enabled}
          onChange={(event) => onFilterChange('enabled', event.target.value)}
        >
          <option value="">{t('nf_health_filter_all_states')}</option>
          <option value="true">{t('nf_health_enabled')}</option>
          <option value="false">{t('nf_health_disabled')}</option>
        </select>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_domain')}
          value={filters.domain}
          onChange={(event) => onFilterChange('domain', event.target.value)}
        >
          <option value="">{t('nf_health_filter_all_domains')}</option>
          {OPERATIONAL_DOMAINS.map((domain) => (
            <option key={domain} value={domain}>
              {t(`ops_domain_${domain}`)}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_overall')}
          value={filters.overall}
          onChange={(event) => onFilterChange('state', event.target.value)}
        >
          <option value="">{t('nf_health_filter_all_overall')}</option>
          {HEALTH_OVERALL_STATES.map((state) => (
            <option key={state} value={state}>
              {t(`nf_health_state_${state}`)}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_layers')}
          value={filters.layer}
          onChange={(event) => onFilterChange('layers', event.target.value)}
        >
          <option value="">{t('nf_health_filter_all_layers')}</option>
          {HEALTH_LAYER_FILTERS.map((layer) => (
            <option key={layer} value={layer}>
              {t(`nf_health_layer_${layer}_measured_filter`)}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_freshness')}
          value={filters.freshness}
          onChange={(event) => onFilterChange('freshness', event.target.value)}
        >
          <option value="">{t('nf_health_filter_all_freshness')}</option>
          {HEALTH_FRESHNESS_STATES.map((state) => (
            <option key={state} value={state}>
              {t(`nf_health_freshness_${state}`)}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_collection')}
          value={filters.collection}
          onChange={(event) => onFilterChange('collection', event.target.value)}
        >
          <option value="">{t('nf_health_filter_all_collection')}</option>
          {HEALTH_COLLECTION_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {t(`nf_health_collection_${outcome}`)}
            </option>
          ))}
        </select>
        <select
          className="form-input"
          aria-label={t('nf_health_filter_sort')}
          value={filters.sort}
          onChange={(event) => onFilterChange('sort', event.target.value)}
        >
          {HEALTH_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {sort === 'risk' ? t('nf_health_sort_risk') : t('nf_health_sort_updated')}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClearFilters}
          disabled={disabled || !filtersActive}
        >
          <X size={14} aria-hidden="true" />
          {t('nf_health_clear_filters')}
        </button>
      </div>
    </div>
  );
}
