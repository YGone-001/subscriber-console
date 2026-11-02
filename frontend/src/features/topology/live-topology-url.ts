/*
 * URL state for the live (runtime + configured) canvas.
 *
 * The graph is one of several sources on `/topology`, and the page already owns
 * its own query contract (`view`, `state`, `relationship`, `from`, `to`). This
 * hook therefore reads and writes only its own keys and merges them into the
 * existing query: it never rebuilds the search string from a private allow list,
 * so entering the live view cannot drop the ledger's filters.
 *
 * Writes use `replace`, so typing in the search box or switching a domain does
 * not fill the Back history with intermediate states.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TopologyDomainMode } from './nf-classification';
import { ACTUAL_DOMAIN_MODE_OPTIONS } from './actual-topology-model';

export const LIVE_VIEW_SEARCH_PARAM = 'q';
export const LIVE_VIEW_DOMAIN_PARAM = 'domain';
export const LIVE_VIEW_FOCUS_PARAM = 'focus';
export const LIVE_VIEW_EDGE_PARAM = 'edge';

export type LiveViewState = {
  search: string;
  domain: TopologyDomainMode;
  focus: string | undefined;
  edge: string | undefined;
};

const KNOWN_DOMAINS = new Set<string>(ACTUAL_DOMAIN_MODE_OPTIONS.map((option) => option.value));

/** Reads the live view state, degrading an unknown domain to `all`. */
export function readLiveViewState(params: URLSearchParams): LiveViewState {
  const domain = params.get(LIVE_VIEW_DOMAIN_PARAM) ?? '';
  return {
    search: params.get(LIVE_VIEW_SEARCH_PARAM) ?? '',
    domain: (KNOWN_DOMAINS.has(domain) ? domain : 'all') as TopologyDomainMode,
    focus: params.get(LIVE_VIEW_FOCUS_PARAM) || undefined,
    edge: params.get(LIVE_VIEW_EDGE_PARAM) || undefined,
  };
}

/**
 * Applies one live-view key while keeping every other parameter untouched.
 * An empty value removes the key so a default never occupies the address bar.
 */
export function withLiveViewParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const normalized = (value ?? '').trim();
  if (normalized && normalized !== (key === LIVE_VIEW_DOMAIN_PARAM ? 'all' : '')) {
    next.set(key, normalized);
  } else {
    next.delete(key);
  }
  return next;
}

export function useLiveTopologyViewState(): LiveViewState & {
  setSearch: (value: string) => void;
  setDomain: (value: TopologyDomainMode) => void;
  setFocus: (value: string | undefined) => void;
  setEdge: (value: string | undefined) => void;
  /* Focus and edge are one selection: writing them in a single update avoids a
   * second setter rebuilding the URL from the pre-update query and restoring
   * the value the first setter just removed. */
  setSelection: (focus: string | undefined, edge: string | undefined) => void;
} {
  const [params, setParams] = useSearchParams();
  const { search, domain, focus, edge } = readLiveViewState(params);

  const apply = useCallback((key: string, value: string | undefined) => {
    setParams((current) => withLiveViewParam(current, key, value), { replace: true });
  }, [setParams]);

  /* Memoized so a panel prop keeps a stable identity between renders. The
   * setter still follows the current location: a consumer must call the value
   * from its latest render, never one captured when the panel first opened. */
  const setSearch = useCallback((value: string) => apply(LIVE_VIEW_SEARCH_PARAM, value), [apply]);
  const setDomain = useCallback((value: TopologyDomainMode) => apply(LIVE_VIEW_DOMAIN_PARAM, value), [apply]);
  const setFocus = useCallback((value: string | undefined) => apply(LIVE_VIEW_FOCUS_PARAM, value), [apply]);
  const setEdge = useCallback((value: string | undefined) => apply(LIVE_VIEW_EDGE_PARAM, value), [apply]);
  const setSelection = useCallback((focusValue: string | undefined, edgeValue: string | undefined) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (focusValue) next.set(LIVE_VIEW_FOCUS_PARAM, focusValue);
      else next.delete(LIVE_VIEW_FOCUS_PARAM);
      if (edgeValue) next.set(LIVE_VIEW_EDGE_PARAM, edgeValue);
      else next.delete(LIVE_VIEW_EDGE_PARAM);
      return next;
    }, { replace: true });
  }, [setParams]);

  return useMemo(
    () => ({ search, domain, focus, edge, setSearch, setDomain, setFocus, setEdge, setSelection }),
    [search, domain, focus, edge, setSearch, setDomain, setFocus, setEdge, setSelection],
  );
}
