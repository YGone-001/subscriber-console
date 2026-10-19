/*
 * Shared operations page frame.
 *
 * Five routes present one workbench, so they share one chrome:
 *
 *   compact title + primary action
 *   shared OperationsNav
 *   optional context strip (scope / completeness / live state)
 *   optional page-local view switch and filters
 *   one primary workspace
 *
 * Two behaviours are centralised here rather than repeated per page:
 *   - the single refresh control (see operations-refresh.tsx);
 *   - the fixed vertical order, so the workspace starts directly under the tabs
 *     instead of under a third navigation layer.
 *
 * The frame owns no data and performs no reads. It renders what a page passes in
 * and nothing else, which keeps the read/write ownership of each route intact.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { useI18n } from '../../providers/I18nProvider';
import { OperationsNav } from './OperationsNav';
import {
  OperationsRefreshProvider,
  useOperationsRefreshRegistry,
  useOperationsRefreshing,
} from './operations-refresh';
import styles from '../../styles/modules/operations-frame.module.css';

export type OperationsPageFrameProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  /* Page-local view switch, rendered next to the refresh control. */
  viewSwitch?: ReactNode;
  /* Context strip content: scope, completeness or live-state facts only. */
  status?: ReactNode;
  /* Page-local filters, rendered directly above the workspace. */
  filters?: ReactNode;
  /* Primary action for the page (create / configure). */
  actions?: ReactNode;
  /* Revalidates the data the page itself owns. Sections register separately. */
  onRefresh?: () => void | Promise<void>;
  children: ReactNode;
};

export function OperationsPageFrame({
  title,
  description,
  icon,
  viewSwitch,
  status,
  filters,
  actions,
  onRefresh,
  children,
}: OperationsPageFrameProps) {
  return (
    <OperationsRefreshProvider>
      <div className="container animate-fade-in">
        <PageHeader
          compact
          icon={icon}
          title={title}
          description={description}
          actions={(
            <>
              {viewSwitch}
              <OperationsRefreshControl onRefresh={onRefresh} />
              {actions}
            </>
          )}
        />
        <OperationsNav />
        {status ? (
          <div className={styles.contextStrip} role="status" aria-live="polite">
            {status}
          </div>
        ) : null}
        {filters ? <div className={styles.filterBar}>{filters}</div> : null}
        <div className={styles.workspace}>{children}</div>
      </div>
    </OperationsRefreshProvider>
  );
}

/**
 * The page's only refresh entry.
 *
 * It runs the page loader and every section loader registered with the frame in
 * one pass. `aria-busy` reports the state to assistive technology without
 * announcing each section's completion.
 */
function OperationsRefreshControl({ onRefresh }: { onRefresh?: () => void | Promise<void> }) {
  const { t } = useI18n();
  const registry = useOperationsRefreshRegistry();
  const sectionPending = useOperationsRefreshing();
  const [pagePending, setPagePending] = useState(false);
  const busy = pagePending || sectionPending;

  const run = useCallback(async () => {
    setPagePending(true);
    try {
      const tasks: Array<Promise<unknown>> = [];
      if (onRefresh) tasks.push(Promise.resolve().then(onRefresh));
      if (registry) tasks.push(registry.run());
      await Promise.allSettled(tasks);
    } finally {
      setPagePending(false);
    }
  }, [onRefresh, registry]);

  return (
    <button
      type="button"
      className="btn btn-secondary"
      onClick={() => void run()}
      disabled={busy}
      aria-busy={busy}
      data-operations-refresh="page"
    >
      <RefreshCw size={16} className={busy ? styles.spin : undefined} aria-hidden="true" />
      {t('refresh')}
    </button>
  );
}

export default OperationsPageFrame;
