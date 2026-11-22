/*
 * Declared-relationship ledger read controller.
 *
 * One owner for the ledger query's read lifecycle: the request token, the
 * in-flight cancellation, the returned page, its pagination metadata, the read
 * time and the cursor walk. The page keeps the URL contract and the mutation
 * workflows; this hook never writes history and never decides which view is
 * active beyond the `enabled` gate it is given.
 *
 * Safety rules this file exists to hold:
 *   - a superseded read can never overwrite a newer one, because every read
 *     carries a monotonic token and an abort controller;
 *   - a failed read is not an empty ledger: the error is reported separately and
 *     the rows are cleared rather than left behind as if they were current;
 *   - a cursor belongs to one query. The cursor trail is dropped the moment the
 *     query identity changes, so page N of a discarded filter set cannot be
 *     requested or displayed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLatestRequestGuard } from '../../lib/api/latest-request';
import { useI18n } from '../../providers/I18nProvider';
import { fetchTopologyEdges } from './topology-api';
import type { TopologyEdge } from './topology-types';

export const TOPOLOGY_LEDGER_PAGE_LIMIT = 20;

/** The effective ledger query. `lifecycleState` already carries its default. */
export type TopologyLedgerQuery = {
  lifecycleState: string;
  relationshipType: string;
  fromResourceId: string;
  toResourceId: string;
};

export type TopologyLedgerController = {
  edges: TopologyEdge[];
  loading: boolean;
  error: string | null;
  /** Read time of this surface, not a server-supplied evidence timestamp. */
  readAt: string;
  hasMore: boolean;
  canPageForward: boolean;
  pageIndex: number;
  /** Re-reads the current query at the given cursor (defaults to the URL cursor). */
  reload: (cursor?: string) => Promise<void>;
  nextPage: () => void;
  prevPage: () => void;
  resetCursorHistory: () => void;
};

/** The identity of a query: changing it invalidates the cursor trail. */
export function topologyLedgerQueryKey(query: TopologyLedgerQuery): string {
  return `${query.lifecycleState}|${query.relationshipType}|${query.fromResourceId}|${query.toResourceId}`;
}

/**
 * One forward page step.
 *
 * The trail records the cursor that produced the page being left, so going back
 * re-requests exactly the page the operator came from instead of an offset.
 */
export function cursorForward(
  history: string[],
  current: string | undefined,
  next: string,
): { history: string[]; cursor: string } {
  return { history: [...history, current ?? ''], cursor: next };
}

/**
 * One backward page step, or null when the first page is already shown.
 *
 * An empty recorded cursor is the first page, which is the absence of a cursor -
 * never an empty `cursor=` parameter.
 */
export function cursorBack(
  history: string[],
): { history: string[]; cursor: string | undefined } | null {
  if (history.length === 0) return null;
  const next = [...history];
  const previous = next.pop() ?? '';
  return { history: next, cursor: previous || undefined };
}

export function useTopologyLedger({
  enabled,
  query,
  cursor,
  onCursorChange,
}: {
  /** False while another primary view is active: the ledger is read on demand. */
  enabled: boolean;
  query: TopologyLedgerQuery;
  /** The cursor currently named by the URL. */
  cursor: string | undefined;
  onCursorChange: (cursor: string | undefined) => void;
}): TopologyLedgerController {
  const { t } = useI18n();

  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [readAt, setReadAt] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  const queryKey = topologyLedgerQueryKey(query);
  const queryKeyRef = useRef('');
  /* The ledger is read imperatively on every filter change, so a slow earlier
   * response would otherwise overwrite the list the operator is now looking at.
   * The newest read wins; superseded reads are aborted and their result dropped
   * without being reported as an error. */
  const readGuard = useRef(createLatestRequestGuard());
  const readAbort = useRef<AbortController | null>(null);

  const { lifecycleState, relationshipType, fromResourceId, toResourceId } = query;

  const reload = useCallback(
    async (activeCursor?: string) => {
      const token = readGuard.current.begin();
      readAbort.current?.abort();
      const controller = new AbortController();
      readAbort.current = controller;
      setLoading(true);
      setError(null);
      try {
        const res = await fetchTopologyEdges(
          {
            fromResourceId: fromResourceId || undefined,
            toResourceId: toResourceId || undefined,
            relationshipType: relationshipType || undefined,
            lifecycleState: lifecycleState || undefined,
            cursor: activeCursor,
            limit: TOPOLOGY_LEDGER_PAGE_LIMIT,
          },
          controller.signal,
        );
        if (!readGuard.current.isCurrent(token)) return;
        setEdges(res.edges || []);
        setNextCursor(res.page?.nextCursor ?? null);
        setHasMore(Boolean(res.page?.hasMore));
        setReadAt(new Date().toISOString());
      } catch (err) {
        if (!readGuard.current.isCurrent(token)) return;
        setError(err instanceof Error && err.message ? err.message : t('topology_err_load'));
        setEdges([]);
      } finally {
        if (readGuard.current.isCurrent(token)) setLoading(false);
      }
    },
    [fromResourceId, toResourceId, relationshipType, lifecycleState, t],
  );

  /* A superseded read is already dropped by the guard; aborting the socket on
   * unmount keeps a detached page from resolving in the background. */
  useEffect(() => () => readAbort.current?.abort(), []);

  /* The relationship ledger is only read on its own view: the graph sources
   * must not pay for a query they do not show. */
  useEffect(() => {
    if (!enabled) return;
    if (queryKeyRef.current !== queryKey) {
      queryKeyRef.current = queryKey;
      setCursorHistory([]);
    }
    void reload(cursor);
  }, [enabled, reload, cursor, queryKey]);

  const nextPage = useCallback(() => {
    if (!nextCursor) return;
    const step = cursorForward(cursorHistory, cursor, nextCursor);
    setCursorHistory(step.history);
    onCursorChange(step.cursor);
  }, [nextCursor, cursorHistory, cursor, onCursorChange]);

  const prevPage = useCallback(() => {
    const step = cursorBack(cursorHistory);
    if (!step) return;
    setCursorHistory(step.history);
    onCursorChange(step.cursor);
  }, [cursorHistory, onCursorChange]);

  const resetCursorHistory = useCallback(() => setCursorHistory([]), []);

  return useMemo(
    () => ({
      edges,
      loading,
      error,
      readAt,
      hasMore,
      canPageForward: Boolean(nextCursor) && hasMore,
      pageIndex: cursorHistory.length + 1,
      reload,
      nextPage,
      prevPage,
      resetCursorHistory,
    }),
    [edges, loading, error, readAt, hasMore, nextCursor, cursorHistory.length, reload, nextPage, prevPage, resetCursorHistory],
  );
}
