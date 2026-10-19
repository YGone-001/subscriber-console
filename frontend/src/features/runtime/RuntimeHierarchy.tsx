/*
 * Observed runtime hierarchy.
 *
 * A read-only tree derived from verified host and process membership:
 *
 *   Local host
 *     +-- EPC
 *     |    +-- MME (running, pid 1234)
 *     +-- 5GC
 *          +-- AMF (running, pid 2345)
 *
 * It is deliberately NOT the declared Inventory/Topology hierarchy and it never
 * implies protocol connectivity: no SIP, Diameter, PFCP, SBI, GTP or NGAP edge is
 * created, suggested or rendered. Observed membership is not persisted as a
 * Topology edge, so the declared graph stays exactly what an operator authored.
 */
import { ChevronDown, ChevronRight, Network } from 'lucide-react';
import { useState } from 'react';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import { groupByCategory, statusLabelKey } from './runtime-model';
import type { RuntimeObservations } from './runtime-types';
import { useRegisterOperationsRefresh } from '../operations/operations-refresh';
import { resolveRuntimeObservations, useRuntimeStream } from './use-runtime-stream';
import styles from '../../styles/modules/runtime.module.css';

export function RuntimeHierarchy() {
  const { t } = useI18n();
  const observations = useRead<RuntimeObservations>('/api/runtime/observations');
  const stream = useRuntimeStream();

  // UX-3: the runtime view is a peer of the canvas and the ledger, so its
  // loader joins the page frame's single refresh entry.
  useRegisterOperationsRefresh('topology:runtime', () => {
    void observations.mutate();
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const snapshot = resolveRuntimeObservations(stream, observations.data)?.snapshot;
  const groups = groupByCategory(snapshot?.components ?? []);
  const visible = groups
    .map((group) => ({
      ...group,
      // Recognised-but-absent components are listed as registry targets, never
      // as running members of the hierarchy.
      components: group.components,
    }))
    .filter((group) => group.components.length > 0);

  return (
    <section className={styles.hierarchy} aria-labelledby="runtime-hierarchy-title" data-testid="runtime-hierarchy">
      <div className={styles.head}>
        <div>
          <h2 id="runtime-hierarchy-title" className={styles.title}>
            <Network size={18} /> {t('runtime_hierarchy_title')}
          </h2>
          <p className={styles.note}>{t('runtime_hierarchy_note')}</p>
        </div>
      </div>

      {!snapshot || visible.length === 0 ? (
        <p className={styles.emptyFiltered}>{t('runtime_hierarchy_empty')}</p>
      ) : (
        <>
          <ul className={styles.tree}>
            <li className={styles.treeNode}>
              <span className={styles.treeLabel}>
                {t('runtime_hierarchy_host')}: {snapshot.host.hostName}
              </span>
              <code className={styles.hostId}>{snapshot.host.hostId}</code>
              <ul className={styles.treeChildren}>
                {visible.map((group) => {
                  const isOpen = open[group.category] !== false;
                  return (
                    <li key={group.category} className={styles.treeNode}>
                      <button
                        type="button"
                        className={styles.treeToggleButton}
                        aria-expanded={isOpen}
                        onClick={() => setOpen((current) => ({ ...current, [group.category]: !isOpen }))}
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span>{t(`runtime_category_${group.category}`)}</span>
                        <span className={styles.groupCount}>
                          {t('runtime_group_count', { running: group.running, total: group.total })}
                        </span>
                      </button>
                      {isOpen ? (
                        <ul className={styles.treeChildren}>
                          {group.components.map((component) => (
                            <li key={component.componentId} className={styles.treeLeaf}>
                              <span className={styles.treeLeafName}>{component.displayName}</span>
                              <span
                                className={`${styles.badge} ${
                                  component.runtimeStatus === 'running'
                                    ? styles.toneHealthy
                                    : component.runtimeStatus === 'stopped'
                                      ? styles.toneDanger
                                      : styles.toneMuted
                                }`}
                              >
                                {t(statusLabelKey(component.runtimeStatus))}
                              </span>
                              {component.primaryPid > 0 ? (
                                <code className={styles.processName}>pid {component.primaryPid}</code>
                              ) : null}
                              {component.workerCount > 1 ? (
                                <code className={styles.processName}>
                                  {t('runtime_col_workers')} {component.workerCount}
                                </code>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          </ul>
          <p className={styles.footnote}>{t('runtime_hierarchy_declared_note')}</p>
        </>
      )}
    </section>
  );
}
