import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  const panelRef = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!onClose) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const panel = (
    <aside
      ref={panelRef}
      className={styles.inspector}
      aria-label={label}
      data-topology-inspector="true"
      data-inspector-overlay={narrow ? 'true' : undefined}
      role={narrow ? 'dialog' : undefined}
      aria-modal={narrow ? true : undefined}
      tabIndex={-1}
    >
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

  if (narrow && typeof document !== 'undefined') {
    return createPortal(
      <>
        {onClose ? (
          <div className={styles.inspectorBackdrop} aria-hidden="true" onMouseDown={onClose} />
        ) : null}
        {panel}
      </>,
      document.body,
    );
  }
  return panel;
}

export default TopologyInspector;
