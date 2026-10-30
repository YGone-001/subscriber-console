/*
 * Topology URL state.
 *
 * The workspace has three modes, each answering one question:
 *
 *   graph         the environment topology (evidence layer: declared / runtime)
 *   ledger        the declared-relationship ledger
 *   architecture  the static 3GPP reference skeleton projected onto live
 *                 Inventory / Health / Topology / runtime authorities
 *
 * `architecture` is deliberately not a graph evidence source: it is a teaching
 * skeleton with live bindings, not an observed link set. Keeping it in its own
 * mode prevents "reference" from being read as a third kind of measurement.
 *
 * Legacy entry points remain readable and are canonicalised on mount:
 *
 *   (absent)      -> graph + runtime (evidence that exists without data entry)
 *   actual        -> graph + declared
 *   runtime       -> graph + runtime + runtime hierarchy
 *   relationships -> ledger
 *   architecture  -> architecture
 *   source=reference -> architecture
 *
 * The resolver never throws and never leaves an unknown value in the state: an
 * unrecognised mode falls back to the graph, and an unrecognised source falls
 * back to runtime evidence.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { applyOperationsPatch, sanitizeOperationsValue } from '../operations/operations-url-state';

export const TOPOLOGY_PRIMARY_VIEWS = ['graph', 'ledger', 'architecture'] as const;
export type TopologyPrimaryView = (typeof TOPOLOGY_PRIMARY_VIEWS)[number];

export const TOPOLOGY_GRAPH_SOURCES = ['declared', 'runtime'] as const;
export type TopologyGraphSource = (typeof TOPOLOGY_GRAPH_SOURCES)[number];

export const TOPOLOGY_RUNTIME_SCOPES = ['config', 'hierarchy'] as const;
export type TopologyRuntimeScope = (typeof TOPOLOGY_RUNTIME_SCOPES)[number];

export const TOPOLOGY_VIEW_PARAM = 'view';
export const TOPOLOGY_SOURCE_PARAM = 'source';
export const TOPOLOGY_SCOPE_PARAM = 'scope';
export const TOPOLOGY_CURSOR_PARAM = 'cursor';

export const TOPOLOGY_VIEW_KEYS = [
  TOPOLOGY_VIEW_PARAM,
  TOPOLOGY_SOURCE_PARAM,
  TOPOLOGY_SCOPE_PARAM,
  TOPOLOGY_CURSOR_PARAM,
] as const;

export type TopologyViewState = {
  primary: TopologyPrimaryView;
  source: TopologyGraphSource;
  runtimeScope: TopologyRuntimeScope;
};

export const DEFAULT_TOPOLOGY_VIEW_STATE: TopologyViewState = {
  primary: 'graph',
  source: 'runtime',
  runtimeScope: 'config',
};

function includes<T extends string>(values: readonly T[], candidate: string): candidate is T {
  return (values as readonly string[]).includes(candidate);
}

function toParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === 'string' ? new URLSearchParams(search) : new URLSearchParams(search);
}

/**
 * Resolve the workspace state from a query string.
 *
 * Precedence: an explicit valid `source` is more specific than the source
 * implied by a legacy view alias, so `view=actual&source=runtime` shows runtime
 * evidence inside the graph. A `scope` only applies to runtime evidence.
 */
export function resolveTopologyViewState(search: string | URLSearchParams): TopologyViewState {
  const params = toParams(search);
  const view = sanitizeOperationsValue(params.get(TOPOLOGY_VIEW_PARAM));
  const requestedSource = sanitizeOperationsValue(params.get(TOPOLOGY_SOURCE_PARAM));
  const requestedScope = sanitizeOperationsValue(params.get(TOPOLOGY_SCOPE_PARAM));

  let primary: TopologyPrimaryView = 'graph';
  let source: TopologyGraphSource = 'runtime';
  let runtimeScope: TopologyRuntimeScope = 'config';

  switch (view) {
    case 'ledger':
    case 'relationships':
      primary = 'ledger';
      break;
    case 'architecture':
      primary = 'architecture';
      break;
    case 'actual':
      source = 'declared';
      break;
    case 'runtime':
      source = 'runtime';
      runtimeScope = 'hierarchy';
      break;
    case 'graph':
      break;
    default:
      // Missing or unknown view: the graph with runtime evidence is the entry
      // point, because it is the only layer populated without operator data.
      break;
  }

  /* A legacy `source=reference` link is an architecture link, not a third
   * evidence layer. */
  if (requestedSource === 'reference' && primary === 'graph') {
    primary = 'architecture';
  } else if (primary === 'graph' && includes(TOPOLOGY_GRAPH_SOURCES, requestedSource)) {
    source = requestedSource;
  }

  if (primary === 'graph' && source === 'runtime' && includes(TOPOLOGY_RUNTIME_SCOPES, requestedScope)) {
    runtimeScope = requestedScope;
  }
  if (primary !== 'graph' || source !== 'runtime') {
    runtimeScope = 'config';
  }

  return { primary, source, runtimeScope };
}

/**
 * Rewrite legacy or inconsistent view parameters into the canonical form.
 *
 * Only `view`, `source` and `scope` are touched: ledger filters, the cursor and
 * foreign keys are preserved, and an untouched page keeps a clean address.
 */
export function canonicalizeTopologyViewSearch(
  search: string | URLSearchParams,
): { search: string; changed: boolean } {
  const params = toParams(search);
  const before = params.toString();
  const touchesViewState = params.has(TOPOLOGY_VIEW_PARAM)
    || params.has(TOPOLOGY_SOURCE_PARAM)
    || params.has(TOPOLOGY_SCOPE_PARAM);
  if (!touchesViewState) {
    return { search: before ? `?${before}` : '', changed: false };
  }

  const state = resolveTopologyViewState(params);
  if (state.primary === 'ledger') {
    params.set(TOPOLOGY_VIEW_PARAM, 'ledger');
    params.delete(TOPOLOGY_SOURCE_PARAM);
    params.delete(TOPOLOGY_SCOPE_PARAM);
  } else if (state.primary === 'architecture') {
    params.set(TOPOLOGY_VIEW_PARAM, 'architecture');
    params.delete(TOPOLOGY_SOURCE_PARAM);
    params.delete(TOPOLOGY_SCOPE_PARAM);
  } else {
    params.set(TOPOLOGY_VIEW_PARAM, 'graph');
    params.set(TOPOLOGY_SOURCE_PARAM, state.source);
    if (state.source === 'runtime' && state.runtimeScope === 'hierarchy') {
      params.set(TOPOLOGY_SCOPE_PARAM, 'hierarchy');
    } else {
      params.delete(TOPOLOGY_SCOPE_PARAM);
    }
  }

  const after = params.toString();
  return { search: after ? `?${after}` : '', changed: after !== before };
}

/** The keys a state change writes; `null` removes a key. */
export function topologyViewStatePatch(state: TopologyViewState): Record<string, string | null> {
  if (state.primary === 'ledger') {
    return {
      [TOPOLOGY_VIEW_PARAM]: 'ledger',
      [TOPOLOGY_SOURCE_PARAM]: null,
      [TOPOLOGY_SCOPE_PARAM]: null,
    };
  }
  if (state.primary === 'architecture') {
    return {
      [TOPOLOGY_VIEW_PARAM]: 'architecture',
      [TOPOLOGY_SOURCE_PARAM]: null,
      [TOPOLOGY_SCOPE_PARAM]: null,
    };
  }
  return {
    [TOPOLOGY_VIEW_PARAM]: 'graph',
    [TOPOLOGY_SOURCE_PARAM]: state.source,
    [TOPOLOGY_SCOPE_PARAM]: state.source === 'runtime' && state.runtimeScope === 'hierarchy'
      ? 'hierarchy'
      : null,
  };
}

export type TopologyViewStateController = TopologyViewState & {
  setPrimaryView: (view: TopologyPrimaryView) => void;
  setSource: (source: TopologyGraphSource) => void;
  setRuntimeScope: (scope: TopologyRuntimeScope) => void;
};

/**
 * React binding for the topology URL contract.
 *
 * `extraKeys` are the page's non-view parameters (ledger filters). They are
 * preserved by every view change; a view change still resets the cursor through
 * the shared operations patch contract.
 */
export function useTopologyViewState(extraKeys: readonly string[] = []): TopologyViewStateController {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => resolveTopologyViewState(params), [params]);
  const canonical = useMemo(() => canonicalizeTopologyViewSearch(params), [params]);

  useEffect(() => {
    if (!canonical.changed) return;
    setParams(new URLSearchParams(canonical.search.startsWith('?') ? canonical.search.slice(1) : canonical.search), {
      replace: true,
    });
  }, [canonical, setParams]);

  const extraSignature = extraKeys.join(',');
  const allowList = useMemo(
    () => [...new Set([...TOPOLOGY_VIEW_KEYS, ...extraSignature.split(',').filter(Boolean)])],
    [extraSignature],
  );

  const applyState = useCallback(
    (next: TopologyViewState) => {
      const result = applyOperationsPatch(params, topologyViewStatePatch(next), allowList);
      if (!result.changed) return;
      setParams(new URLSearchParams(result.search.startsWith('?') ? result.search.slice(1) : result.search));
    },
    [params, setParams, allowList],
  );

  const setPrimaryView = useCallback(
    (primary: TopologyPrimaryView) => applyState({ ...state, primary }),
    [applyState, state],
  );

  const setSource = useCallback(
    (source: TopologyGraphSource) => applyState({
      primary: 'graph',
      source,
      runtimeScope: source === 'runtime' ? state.runtimeScope : 'config',
    }),
    [applyState, state.runtimeScope],
  );

  const setRuntimeScope = useCallback(
    (runtimeScope: TopologyRuntimeScope) => applyState({ primary: 'graph', source: 'runtime', runtimeScope }),
    [applyState],
  );

  return useMemo(
    () => ({ ...state, setPrimaryView, setSource, setRuntimeScope }),
    [state, setPrimaryView, setSource, setRuntimeScope],
  );
}
