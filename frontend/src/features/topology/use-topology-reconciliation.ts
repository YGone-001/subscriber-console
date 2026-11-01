/*
 * Advisory reconciliation for the declared-topology surface.
 *
 * The declared canvas holds the ledger; the configured evidence and the diff
 * against it are produced by the live projection. This hook reads that projection
 * for the diff only and never writes the ledger: registering or retiring a
 * relationship stays an explicit operator action.
 *
 * A projection that cannot be read leaves the diff absent (`null`) instead of
 * rendering an empty, reassuring list.
 */
import { useCallback } from 'react';
import { useRead } from '../../lib/api/use-read';
import type { LiveTopologyResponse } from './live-topology-types';
import {
  reconciliationGroups,
  reconciliationSummary,
  type ReconciliationGroups,
  type ReconciliationSummary,
} from './live-topology-model';

export function useTopologyReconciliation(): {
  summary: ReconciliationSummary | null;
  groups: ReconciliationGroups | null;
  refresh: () => void;
} {
  const read = useRead<LiveTopologyResponse>('/api/topology/live');
  const refresh = useCallback(() => {
    void read.mutate();
  }, [read.mutate]);

  return {
    summary: reconciliationSummary(read.data),
    groups: reconciliationGroups(read.data),
    refresh,
  };
}