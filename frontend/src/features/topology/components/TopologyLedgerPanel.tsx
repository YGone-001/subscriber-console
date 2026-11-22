/*
 * Relationship ledger body.
 *
 * Separates the four mutually exclusive ledger states - read failed, first read
 * in flight, no rows, rows - plus the cursor pager, from the request that
 * produced them. It renders exactly what it is given: it never fetches, never
 * pages on its own and never turns a failed read into an empty ledger.
 *
 * The relationship table itself stays the shared `TopologyEdgeTable`, which is
 * also the accessible equivalent representation of the one-hop graph.
 */
import { Plus, Search } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../../components/ui/OperationFeedback';
import { ErrorState } from '../../../components/ui/StatePanel';
import { TopologyEdgeTable } from './TopologyEdgeTable';
import type { ResourceProjection, TopologyEdge } from '../topology-types';
import styles from '../../../styles/modules/topology.module.css';

export type TopologyLedgerPanelProps = {
  edges: TopologyEdge[];
  directory: Record<string, ResourceProjection>;
  loading: boolean;
  error: string | null;
  canPageForward: boolean;
  pageIndex: number;
  canConfigure: boolean;
  /** True when a narrowing filter is active, which changes the empty copy. */
  hasFilters: boolean;
  caption: string;
  onRetry: () => void;
  onNextPage: () => void;
  onPrevPage: () => void;
  onCreate: () => void;
  onActivateRow: (edgeId: string) => void;
  onEdit: (edge: TopologyEdge) => void;
  onRetire: (edge: TopologyEdge) => void;
  onViewResource: (resourceId: string) => void;
};

export function TopologyLedgerPanel({
  edges,
  directory,
  loading,
  error,
  canPageForward,
  pageIndex,
  canConfigure,
  hasFilters,
  caption,
  onRetry,
  onNextPage,
  onPrevPage,
  onCreate,
  onActivateRow,
  onEdit,
  onRetire,
  onViewResource,
}: TopologyLedgerPanelProps) {
  const { t } = useI18n();

  return (
    <>
      {error ? (
        <div className={styles.errorWrap}>
          <ErrorState title={t('error')} message={error} retryLabel={t('retry')} onRetry={onRetry} />
        </div>
      ) : loading && edges.length === 0 ? (
        <LoadingRows columns={9} rows={5} />
      ) : edges.length === 0 ? (
        <div className={styles.stateWrap}>
          <EmptyState
            icon={<Search size={44} />}
            title={hasFilters ? t('topology_empty_search_title') : t('topology_empty_title')}
            description={hasFilters ? t('topology_empty_search_body') : t('topology_empty_body')}
            action={
              canConfigure && !hasFilters ? (
                <button type="button" className="btn btn-primary" onClick={onCreate}>
                  <Plus size={16} />
                  {t('topology_create_relationship')}
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <TopologyEdgeTable
          edges={edges}
          directory={directory}
          caption={caption}
          surface="ledger"
          canConfigure={canConfigure}
          onActivateRow={onActivateRow}
          onEdit={onEdit}
          onRetire={onRetire}
          onViewResource={onViewResource}
        />
      )}

      {!error && edges.length > 0 ? (
        <nav className={styles.pager} aria-label={t('topology_title')}>
          <div className={styles.pagerSummary} aria-live="polite">
            {t('topology_showing_edges', { count: edges.length })}
          </div>
          <div className={styles.pagerControls}>
            <button type="button" onClick={onPrevPage} disabled={pageIndex === 1 || loading}>
              {t('topology_prev_page')}
            </button>
            <span className={styles.pageNumber}>{t('topology_page_indicator', { page: pageIndex })}</span>
            <button type="button" onClick={onNextPage} disabled={!canPageForward || loading}>
              {t('next')}
            </button>
          </div>
        </nav>
      ) : null}
    </>
  );
}
