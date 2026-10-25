/*
 * Topology URL state.
 *
 * One workspace has two primary views (graph / ledger) and the graph has three
 * evidence sources (declared / runtime / reference). All of that lives in the
 * query string so a copied link restores the same evidence context.
 *
 * An absent `view` selects the graph with runtime evidence, because that is the
 * only source that is populated without operator data entry.
 *
 * The legacy `view` values remain valid entry points:
 *
 *   actual       -> graph + declared
 *   architecture -> graph + reference
 *   relationships-> ledger
 *   runtime      -> graph + runtime + runtime hierarchy
 *
 * The resolver never throws and never leaves an unknown value in the state: an
 * unrecognised view falls back to the graph with the declared source, so an
 * explicit but invalid `view` never silently changes evidence, and an
 * unrecognised source falls back to the legacy-derived source.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { applyOperationsPatch, sanitizeOperationsValue } from '../operations/operations-url-state';

export const TOPOLOGY_PRIMARY_VIEWS = ['actual', 'ledger'] as const;
export type TopologyPrimaryView = (typeof TOPOLOGY_PRIMARY_VIEWS)[number];

export const TOPOLOGY_GRAPH_SOURCES = ['declared', 'runtime', 'reference'] as const;
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
  primary: 'actual',
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
 * implied by a legacy view alias, so `view=architecture&source=runtime` shows
 * runtime evidence. A `scope` only applies to the runtime source.
 */
export function resolveTopologyViewState(search: string | URLSearchParams): TopologyViewState {
  const params = toParams(search);
  const view = sanitizeOperationsValue(params.get(TOPOLOGY_VIEW_PARAM));
  const requestedSource = sanitizeOperationsValue(params.get(TOPOLOGY_SOURCE_PARAM));
  const requestedScope = sanitizeOperationsValue(params.get(TOPOLOGY_SCOPE_PARAM));
  /* An omitted `view` is the operator entry point and lands on runtime evidence;
   * a present but unrecognised `view` is a hand-edited link and keeps the
   * historical declared fallback. */
  const hasViewParam = (params.get(TOPOLOGY_VIEW_PARAM) ?? '').trim() !== '';

  let primary: TopologyPrimaryView = 'actual';
  let source: TopologyGraphSource = hasViewParam ? 'declared' : 'runtime';
  let runtimeScope: TopologyRuntimeScope = 'config';

  switch (view) {
    case 'ledger':
    case 'relationships':
      primary = 'ledger';
      break;
    case 'architecture':
      source = 'reference';
      break;
    case 'runtime':
      source = 'runtime';
      runtimeScope = 'hierarchy';
      break;
    case 'actual':
    case 'graph':
      break;
    default:
      // Missing or unknown view: the graph with declared evidence is the default.
      break;
  }

  if (primary === 'actual' && includes(TOPOLOGY_GRAPH_SOURCES, requestedSource)) {
    source = requestedSource;
  }
  if (source === 'runtime' && includes(TOPOLOGY_RUNTIME_SCOPES, requestedScope)) {
    runtimeScope = requestedScope;
  }
  if (primary === 'ledger' || source !== 'runtime') {
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
  } else {
    params.set(TOPOLOGY_VIEW_PARAM, 'actual');
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
  return {
    [TOPOLOGY_VIEW_PARAM]: 'actual',
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
      primary: 'actual',
      source,
      runtimeScope: source === 'runtime' ? state.runtimeScope : 'config',
    }),
    [applyState, state.runtimeScope],
  );

  const setRuntimeScope = useCallback(
    (runtimeScope: TopologyRuntimeScope) => applyState({ primary: 'actual', source: 'runtime', runtimeScope }),
    [applyState],
  );

  return useMemo(
    () => ({ ...state, setPrimaryView, setSource, setRuntimeScope }),
    [state, setPrimaryView, setSource, setRuntimeScope],
  );
}
