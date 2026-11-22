/*
 * Relationship ledger filter toolbar.
 *
 * Presentation only: every control reports an intent and the page decides the
 * canonical URL transition. The toolbar owns no query state and starts no read,
 * so there is exactly one place that decides what the ledger is asked for.
 *
 * Endpoint filters are resolved through the Inventory picker, which yields
 * resource identifiers - never a guessed name or a host address.
 */
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { TopologyFreshnessChip } from './TopologyFreshnessChip';
import { TopologyResourcePicker } from './TopologyResourcePicker';
import { RELATIONSHIP_PRESENTATION, type TopologyMetaResponse } from '../topology-types';
import styles from '../../../styles/modules/topology.module.css';

/** One applied filter, already rendered as text by the page. */
export type TopologyActiveFilter = {
  key: string;
  label: string;
  clear: () => void;
};

export type TopologyLedgerToolbarProps = {
  meta: TopologyMetaResponse | null;
  relationshipType: string;
  lifecycleState: string;
  fromResourceId: string;
  toResourceId: string;
  /** Read time of the ledger surface; never a server evidence timestamp. */
  readAt: string;
  loading: boolean;
  activeFilters: TopologyActiveFilter[];
  onRelationshipChange: (value: string) => void;
  onLifecycleChange: (value: string) => void;
  onFromChange: (resourceId: string) => void;
  onToChange: (resourceId: string) => void;
  onClearFilters: () => void;
};

export function TopologyLedgerToolbar({
  meta,
  relationshipType,
  lifecycleState,
  fromResourceId,
  toResourceId,
  readAt,
  loading,
  activeFilters,
  onRelationshipChange,
  onLifecycleChange,
  onFromChange,
  onToChange,
  onClearFilters,
}: TopologyLedgerToolbarProps) {
  const { t } = useI18n();

  /* Source and target pickers are the heaviest controls on this page, so they
   * live behind a disclosure. An applied endpoint filter re-opens the section so
   * the value that is filtering the ledger stays visible. */
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(fromResourceId || toResourceId));
  useEffect(() => {
    if (fromResourceId || toResourceId) setAdvancedOpen(true);
  }, [fromResourceId, toResourceId]);

  const relationshipLabel = (value: string) => {
    const presentation = RELATIONSHIP_PRESENTATION[value];
    return presentation ? t(presentation.labelKey) : value;
  };

  return (
    <>
      <div className={styles.toolbar}>
        <div className={styles.filterGroup}>
          <select
            className="form-input"
            aria-label={t('topology_relationship')}
            value={relationshipType}
            onChange={(event) => onRelationshipChange(event.target.value)}
          >
            <option value="">{t('topology_all_relationships')}</option>
            {(meta?.relationshipTypes ?? []).map((value) => (
              <option key={value} value={value}>
                {relationshipLabel(value)}
              </option>
            ))}
          </select>
          <select
            className="form-input"
            aria-label={t('topology_lifecycle')}
            value={lifecycleState}
            onChange={(event) => onLifecycleChange(event.target.value === 'active' ? '' : event.target.value)}
          >
            {(meta?.lifecycleStates ?? ['active', 'retired']).map((value) => (
              <option key={value} value={value}>
                {value === 'retired' ? t('topology_state_retired') : t('topology_state_active')}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost" onClick={onClearFilters} disabled={loading}>
            <X size={14} aria-hidden="true" />
            {t('topology_clear_filters')}
          </button>
        </div>
        {/* The ledger is read on demand; state when it was last read. This is
            ledger status, not a page action, so it stays out of the header. */}
        <TopologyFreshnessChip mode="read" sourceTime={readAt || undefined} />
      </div>

      <details
        className={styles.advancedFilters}
        data-ledger-advanced-filters="true"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>{t('topology_advanced_filters')}</summary>
        <div className={styles.resourceFilters}>
          <TopologyResourcePicker
            id="topology-filter-from"
            label={t('topology_filter_from')}
            value={fromResourceId}
            onChange={(resource) => onFromChange(resource?.resourceId ?? '')}
            excludeResourceId={toResourceId || undefined}
          />
          <TopologyResourcePicker
            id="topology-filter-to"
            label={t('topology_filter_to')}
            value={toResourceId}
            onChange={(resource) => onToChange(resource?.resourceId ?? '')}
            excludeResourceId={fromResourceId || undefined}
          />
        </div>
      </details>

      {activeFilters.length > 0 ? (
        <div className={styles.filterTags}>
          <span className={styles.filterTagsLabel}>{t('topology_filter_active')}</span>
          {activeFilters.map((chip) => (
            <button key={chip.key} type="button" onClick={chip.clear}>
              {chip.label}
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
