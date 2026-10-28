/*
 * URL-backed list state for the OCS console surfaces.
 *
 * The three list pages used to keep page/filter/sort in component state, which
 * meant a refresh, a bookmark, or a back-navigation from a detail page silently
 * reset the operator's context. The URL is the state source instead, with one
 * deliberate constraint: the default state is never written back into the URL.
 *
 * Keeping the default state invisible matters for two reasons. It keeps the
 * canonical path clean (`/ocs/tariffs`, not `/ocs/tariffs?q=&status=&page=1`),
 * and it keeps a single SWR cache key for the unfiltered view, so the list is
 * fetched once rather than once per visit from a different entry point.
 *
 * `defaults` must be a module-level constant. The hook keys its memo on that
 * object, so an inline literal would re-create the state on every render.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export type OcsQueryState = Record<string, string>;

export function useOcsQueryState(defaults: OcsQueryState) {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo<OcsQueryState>(() => {
    const next: OcsQueryState = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = searchParams.get(key);
      if (value !== null && value !== '') next[key] = value;
    }
    return next;
  }, [defaults, searchParams]);

  const update = useCallback(
    (patch: OcsQueryState) => {
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value === '' || value === defaults[key]) next.delete(key);
          else next.set(key, value);
        }
        return next;
      }, { replace: true });
    },
    [defaults, setSearchParams],
  );

  const reset = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [setSearchParams]);

  return { state, update, reset };
}

/**
 * True when at least one filter differs from its default.
 *
 * `page` and `limit` are excluded: paging is navigation, not filtering, so it
 * must not light up the "clear filters" affordance.
 */
export function hasActiveOcsFilters(state: OcsQueryState, defaults: OcsQueryState): boolean {
  return Object.keys(defaults).some((key) => {
    if (key === 'page' || key === 'limit') return false;
    return state[key] !== defaults[key];
  });
}
