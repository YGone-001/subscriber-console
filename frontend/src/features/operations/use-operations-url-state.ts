/*
 * React binding for the operations URL contract.
 *
 * The hook owns exactly one concern: keeping a page's view, filters and cursor
 * in the query string so reload, back/forward and a shared link restore the same
 * workspace. It never holds a duplicate copy of the state in component memory,
 * which is what made the previous per-page `useState` filters unrecoverable.
 *
 * Writes go through `useUrlPatchWriter`, which composes against the newest
 * logical search rather than the render closure. That matters because several
 * bindings can write the same route: two patches dispatched in one turn would
 * otherwise both derive from the same committed search and the second would
 * discard the first.
 *
 * Filter changes push a history entry (so Back returns to the previous filter
 * set) and drop the cursor; cursor changes push too, so Back steps between
 * loaded pages. A second write inside the same turn replaces the entry the first
 * one created, so one logical transaction produces one history entry.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useUrlPatchWriter } from './url-patch-coordinator';
import {
  applyOperationsPatch,
  OPERATIONS_CURSOR_PARAM,
  OPERATIONS_VIEW_PARAM,
  operationsSearchToParams,
  readOperationsParams,
  resolveOperationsView,
  type OperationsPatch,
} from './operations-url-state';

export type OperationsUrlStateOptions = {
  /* Filter keys this page reads. `view` and `cursor` are added automatically. */
  keys: readonly string[];
  /* Views the page implements; omitted when the page has no view switch. */
  views?: readonly string[];
  defaultView?: string;
  /* Filter keys cleared by `clearFilters`; defaults to every filter key. */
  clearKeys?: readonly string[];
};

export type OperationsUrlState = {
  view: string;
  filters: Record<string, string>;
  cursor: string | undefined;
  hasFilters: boolean;
  setView: (view: string) => void;
  setFilter: (key: string, value: string) => void;
  setFilters: (patch: OperationsPatch) => void;
  setCursor: (cursor: string | undefined) => void;
  clearFilters: () => void;
};

export function useOperationsUrlState(options: OperationsUrlStateOptions): OperationsUrlState {
  const { keys, views, defaultView = '', clearKeys } = options;
  const keySignature = keys.join(',');
  const clearSignature = clearKeys?.join(',');

  const allowList = useMemo(
    () => [...new Set([...keySignature.split(',').filter(Boolean), OPERATIONS_VIEW_PARAM, OPERATIONS_CURSOR_PARAM])],
    [keySignature],
  );

  /* Display keeps reading the committed location, so the visible state and the
   * address bar never disagree. */
  const [params] = useSearchParams();
  const writer = useUrlPatchWriter();

  const normalized = useMemo(
    () => applyOperationsPatch(params, {}, allowList),
    [params, allowList],
  );
  const normalizedParams = useMemo(
    () => operationsSearchToParams(normalized.search),
    [normalized.search],
  );

  /* Canonicalize hand-edited or stale links without adding a history entry.
   * Consumers read the normalized state immediately, so malformed query values
   * can never reach a page loader during the one render before this effect.
   *
   * The rewrite is applied to the newest logical search rather than to the
   * committed one: a user patch issued in the same turn is carried through
   * instead of being overwritten by a replace based on an older location. */
  useEffect(() => {
    if (!normalized.changed) return;
    const base = operationsSearchToParams(writer.baseSearch());
    const canonical = applyOperationsPatch(base, {}, allowList);
    if (!canonical.changed) return;
    writer.commit(canonical.search, { replace: true });
  }, [normalized.changed, allowList, writer]);

  const apply = useCallback(
    (patch: OperationsPatch) => {
      const base = operationsSearchToParams(writer.baseSearch());
      const result = applyOperationsPatch(base, patch, allowList);
      if (!result.changed) return;
      writer.commit(result.search);
    },
    [writer, allowList],
  );

  const filters = useMemo(() => {
    const result: Record<string, string> = {};
    const parsed = readOperationsParams(normalized.search, allowList);
    for (const key of allowList) {
      if (key === OPERATIONS_VIEW_PARAM || key === OPERATIONS_CURSOR_PARAM) continue;
      const value = parsed[key];
      if (value) result[key] = value;
    }
    return result;
  }, [normalized.search, allowList]);

  const view = resolveOperationsView(normalizedParams.get(OPERATIONS_VIEW_PARAM), views, defaultView);
  const cursor = normalizedParams.get(OPERATIONS_CURSOR_PARAM) ?? undefined;

  const setView = useCallback(
    (next: string) => {
      if (!views || !views.includes(next)) return;
      apply({ [OPERATIONS_VIEW_PARAM]: next });
    },
    [apply, views],
  );

  const setFilter = useCallback((key: string, value: string) => apply({ [key]: value }), [apply]);
  const setFilters = useCallback((patch: OperationsPatch) => apply(patch), [apply]);
  const setCursor = useCallback(
    (next: string | undefined) => apply({ [OPERATIONS_CURSOR_PARAM]: next ?? null }),
    [apply],
  );

  const clearFilters = useCallback(() => {
    const clearable = clearSignature === undefined
      ? allowList
      : clearSignature.split(',').filter(Boolean);
    const patch: OperationsPatch = {};
    for (const key of clearable) {
      if (key === OPERATIONS_VIEW_PARAM || key === OPERATIONS_CURSOR_PARAM) continue;
      patch[key] = null;
    }
    apply(patch);
  }, [apply, allowList, clearSignature]);

  const hasFilters = Object.keys(filters).length > 0;

  /* Stable identity: pages use this object in memo dependencies. */
  return useMemo(
    () => ({
      view,
      filters,
      cursor,
      hasFilters,
      setView,
      setFilter,
      setFilters,
      setCursor,
      clearFilters,
    }),
    [view, filters, cursor, hasFilters, setView, setFilter, setFilters, setCursor, clearFilters],
  );
}
