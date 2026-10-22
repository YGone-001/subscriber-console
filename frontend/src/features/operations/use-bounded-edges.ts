/*
 * Bounded Topology edge reader.
 *
 * Reads the declared relationship authority with cursor pagination, capped at a
 * fixed number of pages so a large topology can never stall the console. The
 * returned coverage is honest: a capped read is `partial`, a failed read is
 * `unavailable`, and a caller must never present a missing edge from a partial
 * read as evidence that the relationship does not exist.
 *
 * Shared by the network-element view (`contains` only) and the architecture
 * canvas (all connectivity relationships).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJsonWithSignal } from '../../lib/api/read-client';
import type { TopologyCoverage } from '../operations/operational-model';

type EdgeListPayload = { edges?: unknown[]; page?: { nextCursor?: string | null; hasMore?: boolean } };

export type BoundedEdgesOptions = {
  enabled?: boolean;
  relationshipType?: string;
  lifecycleState?: string;
  limit?: number;
  maxPages?: number;
};

export function useBoundedEdges(options: BoundedEdgesOptions = {}): {
  edges: unknown[];
  coverage: TopologyCoverage;
  loading: boolean;
  refresh: () => void;
} {
  const {
    enabled = true,
    relationshipType,
    lifecycleState = 'active',
    limit = 200,
    maxPages = 3,
  } = options;

  const [edges, setEdges] = useState<unknown[]>([]);
  const [coverage, setCoverage] = useState<TopologyCoverage>('partial');
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      const collected: unknown[] = [];
      let cursor: string | null = null;
      let pages = 0;
      let hasMore = false;
      try {
        do {
          const params = new URLSearchParams();
          if (relationshipType) params.set('relationshipType', relationshipType);
          if (lifecycleState) params.set('lifecycleState', lifecycleState);
          params.set('limit', String(limit));
          if (cursor) params.set('cursor', cursor);
          const payload = await getJsonWithSignal<EdgeListPayload>(
            `/api/topology/edges?${params.toString()}`,
            controller.signal,
          );
          if (cancelled || runIdRef.current !== runId) return;
          collected.push(...(payload.edges ?? []));
          hasMore = Boolean(payload.page?.hasMore);
          cursor = payload.page?.nextCursor ?? null;
          pages += 1;
        } while (hasMore && cursor && pages < maxPages);
        if (cancelled || runIdRef.current !== runId) return;
        setEdges(collected);
        setCoverage(hasMore ? 'partial' : 'complete');
      } catch {
        if (cancelled || runIdRef.current !== runId) return;
        // Keep whatever was loaded; a partial read is never authoritative.
        setEdges(collected);
        setCoverage(collected.length > 0 ? 'partial' : 'unavailable');
      } finally {
        if (!cancelled && runIdRef.current === runId) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, relationshipType, lifecycleState, limit, maxPages, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { edges, coverage, loading, refresh };
}
