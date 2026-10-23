/*
 * Contextual topology inspector.
 *
 * A container only: node and relationship content is supplied by the owning
 * view, so the declared, runtime and reference sources never grow three
 * different detail shells. The close control is the only behaviour here.
 */
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import styles from '../../../styles/modules/topology.module.css';

export type TopologyInspectorProps = {
  label: string;
  onClose?: () => void;
  children: ReactNode;
};

export function TopologyInspector({ label, onClose, children }: TopologyInspectorProps) {
  const { t } = useI18n();
  return (
    <aside className={styles.inspector} aria-label={label} data-topology-inspector="true">
      <div className={styles.inspectorHeader}>
        <h3 className={styles.inspectorTitle}>{label}</h3>
        {onClose ? (
          <button
            type="button"
            className={styles.inspectorClose}
            onClick={onClose}
            aria-label={t('topology_close_inspector')}
            title={t('topology_close_inspector')}
          >
            <X size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className={styles.inspectorBody}>{children}</div>
    </aside>
  );
}

export default TopologyInspector;
