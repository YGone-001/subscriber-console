/*
 * Shared operational projection loader.
 *
 * Inventory resources and the authoritative bounded NF Health association
 * lookup are joined exactly once per surface. Keeping the join here means the
 * full operational view and the overview summary panel cannot drift apart on
 * completeness, unresolved associations or population semantics.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRead } from '../../lib/api/use-read';
import {
  applyResolvedNFTypes,
  buildOperationalResources,
  combineCompleteness,
  groupByDomain,
  summarizeOperational,
  type CompletenessReport,
  type DimensionCompleteness,
} from './operational-model';

type TargetListPayload = { targets?: unknown[]; page?: { hasMore?: boolean } };
type ResourceListPayload = { resources?: unknown[]; page?: { hasMore?: boolean } };

export function useOperationalOverviewData(limit: number, refreshSignal = 0) {
  const resourcesRead = useRead<ResourceListPayload>(`/api/inventory/resources?limit=${limit}`);

  // Authoritative bounded association lookup for exactly the loaded resources.
  const resourceIds = useMemo(() => {
    const ids = (resourcesRead.data?.resources ?? [])
      .map((resource) => {
        const record = (resource ?? {}) as Record<string, unknown>;
        const value = record._id ?? record.resourceId;
        return typeof value === 'string' ? value : '';
      })
      .filter(Boolean);
    return ids;
  }, [resourcesRead.data]);

  const associationPath = resourceIds.length > 0
    ? `/api/nf-health/targets?resourceIds=${encodeURIComponent(resourceIds.join(','))}`
    : null;
  const associationsRead = useRead<TargetListPayload>(associationPath);

  const refresh = useCallback(() => {
    void resourcesRead.mutate();
    if (associationPath) void associationsRead.mutate();
  }, [resourcesRead, associationsRead, associationPath]);

  const refreshSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignalRef.current === refreshSignal) return;
    refreshSignalRef.current = refreshSignal;
    refresh();
  }, [refresh, refreshSignal]);

  const completeness: CompletenessReport = useMemo(() => {
    const inventory: DimensionCompleteness = resourcesRead.error
      ? 'unavailable'
      : resourcesRead.data
        ? (resourcesRead.data.page?.hasMore ? 'partial' : 'complete')
        : 'partial';
    const monitoring: DimensionCompleteness = !resourceIds.length
      ? (resourcesRead.error ? 'unavailable' : 'partial')
      : associationsRead.error
        ? 'unavailable'
        : associationsRead.data
          ? 'complete'
          : 'partial';
    const targets = associationsRead.data?.targets ?? [];
    const telemetryFailed = targets.some((target) => {
      const record = (target ?? {}) as Record<string, unknown>;
      return record.statusComplete === false;
    });
    const telemetry: DimensionCompleteness = monitoring !== 'complete'
      ? monitoring
      : telemetryFailed
        ? 'partial'
        : 'complete';
    // The operational views render no hierarchy claim in this projection.
    return combineCompleteness({ inventory, monitoring, telemetry, topology: 'complete' });
  }, [resourcesRead.data, resourcesRead.error, associationsRead.data, associationsRead.error, resourceIds.length]);

  const projection = useMemo(() => {
    const associationResolved = !associationsRead.error && Boolean(associationsRead.data);
    const joined = buildOperationalResources(
      resourcesRead.data?.resources,
      associationsRead.data?.targets,
      associationResolved,
    );
    const enriched = applyResolvedNFTypes(joined.items, associationsRead.data?.targets);
    return {
      items: enriched,
      groups: groupByDomain(enriched, completeness),
      summary: summarizeOperational(enriched, completeness),
    };
  }, [resourcesRead.data, associationsRead.data, associationsRead.error, completeness]);

  return {
    resourcesRead,
    associationsRead,
    resourceIds,
    associationPath,
    completeness,
    refresh,
    ...projection,
  };
}
