/*
 * Searchable Inventory resource selector.
 *
 * The resource source is the existing Inventory read authority
 * (GET /api/inventory/resources). Search and pagination stay server-side: the
 * complete Inventory dataset is never copied into frontend memory, and no
 * manual UUID entry is required for normal operation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { fetchInventoryResources } from '../../inventory/inventory-api';
import type { Resource } from '../../inventory/inventory-types';
import { useI18n } from '../../../providers/I18nProvider';
import styles from '../../../styles/modules/topology.module.css';

interface TopologyResourcePickerProps {
  id: string;
  label: string;
  value: string;
  onChange: (resource: Resource | null) => void;
  excludeResourceId?: string;
  disabled?: boolean;
  describedBy?: string;
}

const SEARCH_LIMIT = 8;

export function TopologyResourcePicker({
  id,
  label,
  value,
  onChange,
  excludeResourceId,
  disabled,
  describedBy,
}: TopologyResourcePickerProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Resource[]>([]);
  const [selected, setSelected] = useState<Resource | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!value) {
      setSelected(null);
      return;
    }
    // Resolve the current selection's display facts without assuming the
    // dataset is held locally.
    let active = true;
    fetchInventoryResources({ q: value, limit: 1 })
      .then((res) => {
        if (!active) return;
        const match = (res.resources || []).find((r) => r.resourceId === value) ?? null;
        setSelected(match);
      })
      .catch(() => {
        /* Selection display is best-effort; the identifier still round-trips. */
      });
    return () => {
      active = false;
    };
  }, [value]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setResults([]);
      setFailed(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    const handle = setTimeout(() => {
      fetchInventoryResources({ q: needle, limit: SEARCH_LIMIT })
        .then((res) => {
          if (seq !== requestSeq.current) return;
          setResults(res.resources || []);
          setFailed(false);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setResults([]);
          setFailed(true);
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    }, 220);
    return () => clearTimeout(handle);
  }, [query]);

  const visibleResults = useMemo(
    () => results.filter((r) => r.resourceId !== excludeResourceId),
    [results, excludeResourceId],
  );

  return (
    <div className={styles.picker} role="group" aria-labelledby={`${id}-label`}>
      <label id={`${id}-label`} htmlFor={id} className={styles.pickerLabel}>
        {label}
      </label>

      {selected ? (
        <div className={styles.pickerSelection}>
          <span className={styles.pickerSelectionBody}>
            <strong>{selected.displayName || selected.name}</strong>
            <small>
              {selected.kind} · {selected.domain}
            </small>
          </span>
          <button
            type="button"
            className={styles.pickerClear}
            onClick={() => {
              setSelected(null);
              onChange(null);
            }}
            disabled={disabled}
          >
            {t('topology_picker_clear')}
          </button>
        </div>
      ) : (
        <p className={styles.pickerEmpty}>{t('topology_picker_none')}</p>
      )}

      <div className={styles.pickerSearch}>
        <Search size={15} aria-hidden="true" />
        <input
          id={id}
          type="search"
          className={styles.pickerInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('topology_picker_search_placeholder')}
          aria-describedby={describedBy}
          aria-controls={`${id}-results`}
          disabled={disabled}
          autoComplete="off"
        />
      </div>

      <div id={`${id}-results`} className={styles.pickerResults} role="listbox" aria-label={label}>
        {loading ? <p className={styles.pickerHint}>{t('loading')}</p> : null}
        {!loading && failed ? <p className={styles.pickerError}>{t('topology_picker_error')}</p> : null}
        {!loading && !failed && query.trim() && visibleResults.length === 0 ? (
          <p className={styles.pickerHint}>{t('topology_picker_no_results')}</p>
        ) : null}
        {!loading
          ? visibleResults.map((resource) => {
              const retired = resource.lifecycleState === 'retired';
              const isSelf = resource.resourceId === excludeResourceId;
              const blocked = retired || isSelf;
              return (
                <button
                  key={resource.resourceId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className={styles.pickerOption}
                  disabled={blocked || disabled}
                  title={blocked ? t('topology_picker_blocked') : resource.resourceId}
                  onClick={() => {
                    setSelected(resource);
                    setQuery('');
                    onChange(resource);
                  }}
                >
                  <span className={styles.pickerOptionName}>{resource.displayName || resource.name}</span>
                  <span className={styles.pickerOptionMeta}>
                    {resource.kind} · {resource.domain} · {resource.lifecycleState}
                  </span>
                </button>
              );
            })
          : null}
      </div>
    </div>
  );
}

export default TopologyResourcePicker;
