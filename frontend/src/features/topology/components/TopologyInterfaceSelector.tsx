/*
 * Controlled interface selector.
 *
 * The only inputs are catalog entries. There is no free-text interface name,
 * no inference from endpoints and no way to exceed the server limit of eight.
 */
import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import type { InterfaceEntry } from '../topology-types';
import { nfRoleLabel } from '../nf-classification';
import {
  interfaceCategoryLabelKey,
  interfaceDomainLabelKey,
  interfaceEndpointRoles,
  interfacePlaneLabelKey,
  interfaceSearchText,
  MAX_INTERFACE_NAMES,
} from '../interface-catalog';
import styles from '../../../styles/modules/topology.module.css';

export interface TopologyInterfaceSelectorProps {
  catalog: InterfaceEntry[];
  selected: string[];
  onChange: (names: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}

const CATEGORY_ORDER = ['reference_point', 'sbi'];
const DOMAIN_ORDER = ['5gc', 'epc', 'ims', 'charging'];

function primaryDomain(entry: InterfaceEntry): string {
  return entry.domains.find((domain) => DOMAIN_ORDER.includes(domain)) ?? 'unclassified';
}

export function TopologyInterfaceSelector({
  catalog,
  selected,
  onChange,
  disabled = false,
  idPrefix = 'topology-interface',
}: TopologyInterfaceSelectorProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const atLimit = selected.length >= MAX_INTERFACE_NAMES;
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = catalog.filter((entry) => !query || interfaceSearchText(entry).includes(query));
    const buckets = new Map<string, { category: string; domain: string; entries: InterfaceEntry[] }>();
    for (const entry of filtered) {
      const category = entry.category;
      const domain = primaryDomain(entry);
      const key = `${category}:${domain}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.entries.push(entry);
      else buckets.set(key, { category, domain, entries: [entry] });
    }
    return [...buckets.values()]
      .map((bucket) => ({
        ...bucket,
        entries: [...bucket.entries].sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => (
        CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category)
        || DOMAIN_ORDER.indexOf(left.domain) - DOMAIN_ORDER.indexOf(right.domain)
      ));
  }, [catalog, search]);

  const toggle = (name: string) => {
    if (selectedSet.has(name)) {
      onChange(selected.filter((value) => value !== name));
      return;
    }
    if (atLimit) return;
    onChange([...selected, name]);
  };

  return (
    <fieldset className={styles.interfaceSet} data-interface-selector="true">
      <legend>{t('topology_interface_title')}</legend>
      <p className={styles.interfaceHint}>{t('topology_interface_hint')}</p>

      <div className={styles.interfaceSetHeader}>
        <label className={styles.interfaceSearch}>
          <Search size={14} aria-hidden="true" />
          <span className="sr-only">{t('topology_interface_search')}</span>
          <input
            id={`${idPrefix}-search`}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('topology_interface_search')}
            disabled={disabled}
          />
        </label>
        <span className={styles.interfaceCounter} data-interface-counter="true">
          {t('topology_interface_selected', {
            count: selected.length,
            max: MAX_INTERFACE_NAMES,
          })}
        </span>
      </div>

      {selected.length > 0 ? (
        <div className={styles.interfaceSelected}>
          {selected.map((name) => (
            <button
              key={name}
              type="button"
              className={styles.interfaceChip}
              data-selected-interface={name}
              onClick={() => toggle(name)}
              disabled={disabled}
              aria-label={t('topology_interface_remove', { name })}
            >
              {name}
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}

      {catalog.length === 0 ? (
        <p className={styles.interfaceEmpty}>{t('topology_interface_catalog_unavailable')}</p>
      ) : groups.length === 0 ? (
        <p className={styles.interfaceEmpty}>{t('topology_interface_no_match')}</p>
      ) : (
        <div className={styles.interfaceOptions}>
          {groups.map((group) => (
            <section
              key={`${group.category}:${group.domain}`}
              className={styles.interfaceGroup}
              data-interface-group={`${group.category}:${group.domain}`}
            >
              <h4 className={styles.interfaceGroupTitle}>
                {t(interfaceCategoryLabelKey(group.category))}
                {' · '}
                {t(interfaceDomainLabelKey(group.domain))}
              </h4>
              {group.entries.map((entry) => {
                const checked = selectedSet.has(entry.name);
                const optionDisabled = disabled || (!checked && atLimit);
                const roles = interfaceEndpointRoles(entry);
                return (
                  <label
                    key={entry.name}
                    className={`${styles.interfaceOption} ${checked ? styles.interfaceOptionSelected : ''}`}
                    data-interface-name={entry.name}
                    data-interface-category={entry.category}
                    title={`${entry.description} (${entry.spec})`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={optionDisabled}
                      onChange={() => toggle(entry.name)}
                    />
                    <span className={styles.interfaceOptionBody}>
                      <span className={styles.interfaceOptionTitle}>
                        <strong>{entry.name}</strong>
                        <span className={styles.interfaceBadges}>
                          {entry.domains.map((domain) => (
                            <span key={domain} className={styles.interfaceBadge}>
                              {t(interfaceDomainLabelKey(domain))}
                            </span>
                          ))}
                          <span className={styles.interfaceBadge}>{t(interfacePlaneLabelKey(entry.plane))}</span>
                        </span>
                      </span>
                      <span className={styles.interfaceOptionMeta}>{entry.spec}</span>
                      <span className={styles.interfaceSuggestion}>
                        {entry.producerRole
                          ? t('topology_interface_producer', { role: nfRoleLabel(entry.producerRole) })
                          : roles.length > 0
                            ? t('topology_interface_endpoints', {
                              endpoints: roles.map((role) => nfRoleLabel(role)).join(' / '),
                            })
                            : t('topology_interface_variable_endpoints')}
                      </span>
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {atLimit && !disabled ? (
        <p className={styles.interfaceLimit} role="status">
          {t('topology_interface_limit', { max: MAX_INTERFACE_NAMES })}
        </p>
      ) : null}
    </fieldset>
  );
}

export default TopologyInterfaceSelector;
