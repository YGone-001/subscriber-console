/*
 * Authoritative monitoring projection for the declared-topology canvas.
 *
 * The NF Health association lookup accepts at most 50 canonical Inventory
 * identifiers per request, so larger canvases are read in bounded chunks.
 * Only a chunk whose request succeeded can establish absence; identifiers in a
 * failed chunk stay unresolved and are never reported as unmonitored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNfHealthTargetsByResources } from '../nf-health/nf-health-api';
import type { TopologyCoverage } from '../operations/operational-model';
import { projectNodeHealth, type NodeHealth } from './actual-topology-health';

const CHUNK_SIZE = 50;

type TopologyHealthState = {
  byResource: Map<string, NodeHealth>;
  coverage: TopologyCoverage;
  loading: boolean;
};

const EMPTY: TopologyHealthState = {
  byResource: new Map(),
  coverage: 'complete',
  loading: false,
};

export function useTopologyHealth(resourceIds: string[]): TopologyHealthState & { refresh: () => void } {
  const key = [...new Set(resourceIds.filter(Boolean))].sort().join(',');
  const [state, setState] = useState<TopologyHealthState>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const runIdRef = useRef(0);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) {
      setState(EMPTY);
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const controller = new AbortController();
    let cancelled = false;

    const load = async () => {
      setState((current) => ({ ...current, loading: true }));
      const chunks: string[][] = [];
      for (let index = 0; index < ids.length; index += CHUNK_SIZE) {
        chunks.push(ids.slice(index, index + CHUNK_SIZE));
      }
      const targets: unknown[] = [];
      const resolved = new Set<string>();
      let failedChunks = 0;

      for (const chunk of chunks) {
        try {
          const payload = await fetchNfHealthTargetsByResources(chunk, controller.signal);
          if (cancelled || runIdRef.current !== runId) return;
          for (const resourceId of chunk) resolved.add(resourceId);
          targets.push(...(payload.targets ?? []));
        } catch {
          if (cancelled || runIdRef.current !== runId) return;
          failedChunks += 1;
        }
      }
      if (cancelled || runIdRef.current !== runId) return;

      const coverage: TopologyCoverage = failedChunks === 0
        ? 'complete'
        : failedChunks === chunks.length
          ? 'unavailable'
          : 'partial';
      setState({
        byResource: projectNodeHealth(ids, targets, resolved),
        coverage,
        loading: false,
      });
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, nonce]);

  return { ...state, refresh };
}
