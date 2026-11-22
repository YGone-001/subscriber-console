/*
 * Same-turn URL patch coordination.
 *
 * The operations URL has several writers on one route: the page's view and filter
 * binding, the topology view-state binding, and the graph selection binding. Each
 * writer composes a new query string from the search it can see. React Router's
 * `setSearchParams` composes from the search captured in the render closure, and
 * `navigate` does not update that closure before the next render - so two writes
 * dispatched in one turn both compose from the same committed search, and the
 * second silently discards the first.
 *
 * This module holds the one thing needed to fix that: the search a writer most
 * recently composed and has not yet seen committed. A writer reads it as its
 * base, applies its own patch, and records the result. The value is transient by
 * construction:
 *
 *   - it is scoped to one location key and one pathname, so a browser
 *     Back/Forward navigation, a new explicit location, or a different route can
 *     never compose on top of it;
 *   - it is replaced by the next write and ignored once the router commits the
 *     navigation it described;
 *   - it is never read for display. The UI keeps rendering from the committed
 *     location, so this is a composition base, not a second URL authority.
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export type UrlPatchCommitOptions = {
  /* Forces `replace` history semantics; a same-turn follow-up write defaults to
   * `replace` anyway so one logical transaction produces one history entry. */
  replace?: boolean;
};

type PendingEntry = {
  locationKey: string;
  pathname: string;
  search: string;
};

let pendingEntry: PendingEntry | null = null;

/** The search a writer should compose against, or null when none is pending. */
export function readPendingSearch(locationKey: string, pathname: string): string | null {
  if (!pendingEntry) return null;
  if (pendingEntry.locationKey !== locationKey) return null;
  if (pendingEntry.pathname !== pathname) return null;
  return pendingEntry.search;
}

/** Records the search a writer just composed. */
export function writePendingSearch(locationKey: string, pathname: string, search: string): void {
  pendingEntry = { locationKey, pathname, search };
}

/** Drops the pending entry; used when a commit is observed and by tests. */
export function clearPendingSearch(): void {
  pendingEntry = null;
}

export type UrlPatchWriter = {
  /* Compose against the newest logical search, pending patch included. */
  baseSearch: () => string;
  /* True when a same-turn patch is already pending for this location. */
  hasPendingPatch: () => boolean;
  /* Navigates to a fully composed search string. */
  commit: (search: string, options?: UrlPatchCommitOptions) => void;
};

export function useUrlPatchWriter(): UrlPatchWriter {
  const navigate = useNavigate();
  const location = useLocation();
  const { key: locationKey, pathname, search: committedSearch, hash } = location;

  const baseSearch = useCallback(
    () => readPendingSearch(locationKey, pathname) ?? committedSearch,
    [locationKey, pathname, committedSearch],
  );

  const hasPendingPatch = useCallback(
    () => readPendingSearch(locationKey, pathname) !== null,
    [locationKey, pathname],
  );

  const commit = useCallback(
    (search: string, options?: UrlPatchCommitOptions) => {
      const normalized = search.startsWith('?') ? search.slice(1) : search;
      /* A second write in the same turn must not add a second history entry: the
       * first navigation already created the entry this transaction will occupy. */
      const collapsing = readPendingSearch(locationKey, pathname) !== null;
      writePendingSearch(locationKey, pathname, normalized);
      navigate(
        { pathname, search: normalized ? `?${normalized}` : '', hash },
        { replace: options?.replace ?? collapsing },
      );
    },
    [navigate, locationKey, pathname, hash],
  );

  return useMemo(
    () => ({ baseSearch, hasPendingPatch, commit }),
    [baseSearch, hasPendingPatch, commit],
  );
}
