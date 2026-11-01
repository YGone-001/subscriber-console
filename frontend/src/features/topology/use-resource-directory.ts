/*
 * Bounded Inventory endpoint directory.
 *
 * The topology list response carries edge documents only - it deliberately
 * stores no copy of Inventory identity. Readable endpoint names are therefore
 * hydrated from the Inventory read authority on demand, in bounded batches, and
 * cached with a short lifetime.
 *
 * Rules:
 *   - identifiers are resolved through the bounded `resourceIds` read, at most
 *     50 per request, so naming a page never walks the whole Inventory;
 *   - an identifier that could not be read stays unresolved and is retried by a
 *     later render: an unreadable name is never cached as a name;
 *   - a cached projection expires, so a renamed or retired resource stops being
 *     shown after the lifetime even without an explicit refresh;
 *   - the cache is scoped to the signed-in identity, so switching account never
 *     leaks the previous session's resource names.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchInventoryResources } from '../inventory/inventory-api';
import type { Resource } from '../inventory/inventory-types';
import { useAuth } from '../../providers/AuthProvider';
import type { ResourceProjection } from './topology-types';

export const RESOURCE_DIRECTORY_TTL_MS = 5 * 60 * 1000;
export const RESOURCE_DIRECTORY_CHUNK = 50;

type CacheEntry = {
  projection: ResourceProjection;
  cachedAt: number;
};

let cache = new Map<string, CacheEntry>();
let cacheScope = '';

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

function unresolved(resourceId: string): ResourceProjection {
  return { resourceId, kind: '', name: '', domain: '', lifecycleState: 'unknown' };
}

function snapshot(now = Date.now()): Record<string, ResourceProjection> {
  const out: Record<string, ResourceProjection> = {};
  for (const [resourceId, entry] of cache) {
    if (now - entry.cachedAt <= RESOURCE_DIRECTORY_TTL_MS) {
      out[resourceId] = entry.projection;
    }
  }
  return out;
}

/** Current resolved names, excluding entries past their lifetime. */
export function resourceDirectorySnapshot(now = Date.now()): Record<string, ResourceProjection> {
  return snapshot(now);
}

/** Drops every cached name; used when the signed-in identity changes. */
export function resetResourceDirectory(): void {
  cache = new Map();
  cacheScope = '';
}

export function chunkResourceIds(
  ids: string[],
  size: number = RESOURCE_DIRECTORY_CHUNK,
): string[][] {
  const chunks: string[][] = [];
  const step = size > 0 ? size : RESOURCE_DIRECTORY_CHUNK;
  for (let index = 0; index < ids.length; index += step) {
    chunks.push(ids.slice(index, index + step));
  }
  return chunks;
}

export function primeResourceDirectory(resources: Resource[], now = Date.now()): void {
  for (const resource of resources) {
    cache.set(resource.resourceId, { projection: toProjection(resource), cachedAt: now });
  }
}

export function primeResourceProjections(
  projections: ResourceProjection[],
  now = Date.now(),
): void {
  for (const projection of projections) {
    cache.set(projection.resourceId, { projection, cachedAt: now });
  }
}

function isFresh(resourceId: string, now: number): boolean {
  const entry = cache.get(resourceId);
  return Boolean(entry) && now - (entry as CacheEntry).cachedAt <= RESOURCE_DIRECTORY_TTL_MS;
}

/**
 * Resolve readable names for the given resource identifiers.
 *
 * @param resourceIds identifiers referenced by the current view
 * @returns a lookup of resolved projections (missing entries are unresolved)
 */
export function useResourceDirectory(resourceIds: string[]): Record<string, ResourceProjection> {
  const { user } = useAuth();
  const scope = user ? `${user.username}|${user.role}` : '';
  const key = [...new Set(resourceIds.filter(Boolean))].sort().join(',');
  const [lookup, setLookup] = useState<Record<string, ResourceProjection>>(() => snapshot());
  const runRef = useRef(0);

  useEffect(() => {
    if (cacheScope !== scope) {
      resetResourceDirectory();
      cacheScope = scope;
    }

    const ids = key ? key.split(',') : [];
    const now = Date.now();
    const pending = ids.filter((resourceId) => !isFresh(resourceId, now));
    if (pending.length === 0) {
      setLookup(snapshot());
      return;
    }

    const run = runRef.current + 1;
    runRef.current = run;
    let active = true;

    void (async () => {
      for (const chunk of chunkResourceIds(pending)) {
        try {
          const res = await fetchInventoryResources({ resourceIds: chunk });
          if (!active || runRef.current !== run) return;
          const returned = new Map((res.resources ?? []).map((item) => [item.resourceId, item]));
          const stamp = Date.now();
          for (const resourceId of chunk) {
            const match = returned.get(resourceId);
            cache.set(resourceId, {
              projection: match ? toProjection(match) : unresolved(resourceId),
              cachedAt: stamp,
            });
          }
        } catch {
          // A failed read leaves the identifiers unresolved so a later render
          // still retries, and a name is never cached from a failure.
        }
      }
      if (active && runRef.current === run) setLookup(snapshot());
    })();

    return () => {
      active = false;
    };
  }, [key, scope]);

  return lookup;
}