/*
 * Bounded Inventory endpoint directory.
 *
 * The topology list response carries edge documents only - it deliberately
 * stores no copy of Inventory identity. Readable endpoint names are therefore
 * hydrated from the Inventory read authority on demand, deduplicated, cached for
 * the session and fetched with a bounded concurrency. The complete Inventory
 * dataset is never copied into frontend memory.
 */
import { useEffect, useState } from 'react';
import { fetchInventoryResources } from '../inventory/inventory-api';
import type { Resource } from '../inventory/inventory-types';
import type { ResourceProjection } from './topology-types';

const cache = new Map<string, ResourceProjection>();
const CONCURRENCY = 4;

function toProjection(resource: Resource): ResourceProjection {
  return {
    resourceId: resource.resourceId,
    kind: resource.kind,
    name: resource.name,
    displayName: resource.displayName,
    domain: resource.domain,
    role: resource.role,
    lifecycleState: resource.lifecycleState,
  };
}

export function primeResourceDirectory(resources: Resource[]): void {
  for (const resource of resources) {
    cache.set(resource.resourceId, toProjection(resource));
  }
}

export function primeResourceProjections(projections: ResourceProjection[]): void {
  for (const projection of projections) {
    cache.set(projection.resourceId, projection);
  }
}

async function resolveOne(resourceId: string): Promise<void> {
  try {
    const res = await fetchInventoryResources({ q: resourceId, limit: 1 });
    const match = (res.resources || []).find((r) => r.resourceId === resourceId);
    if (match) {
      cache.set(resourceId, toProjection(match));
    } else {
      cache.set(resourceId, { resourceId, kind: '', name: '', domain: '', lifecycleState: 'unknown' });
    }
  } catch {
    // Leave unresolved so a later render can retry.
  }
}

/**
 * Resolve readable names for the given resource identifiers.
 *
 * @param resourceIds identifiers referenced by the current view
 * @returns a lookup of resolved projections (missing entries are unresolved)
 */
export function useResourceDirectory(resourceIds: string[]): Record<string, ResourceProjection> {
  const [lookup, setLookup] = useState<Record<string, ResourceProjection>>(() => Object.fromEntries(cache));
  const key = [...new Set(resourceIds.filter(Boolean))].sort().join(',');

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const pending = ids.filter((id) => !cache.has(id));
    if (pending.length === 0) {
      setLookup(Object.fromEntries(cache));
      return;
    }

    let active = true;
    let index = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
      while (index < pending.length) {
        const current = pending[index++];
        await resolveOne(current);
      }
    });

    void Promise.all(workers).then(() => {
      if (active) setLookup(Object.fromEntries(cache));
    });

    return () => {
      active = false;
    };
  }, [key]);

  return lookup;
}
