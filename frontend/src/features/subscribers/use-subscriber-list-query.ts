/*
 * React binding for the Subscribers list-query contract.
 *
 * The URL is the only owner of persistent list state. This hook exposes one
 * atomic write per user transition and canonicalizes an invalid deep link with
 * `replace`, so a hand-edited URL never adds a history entry or reaches the API.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  applySubscriberListPatch,
  parseSubscriberListQuery,
  serializeSubscriberListQuery,
  type SubscriberListPatch,
  type SubscriberListQuery,
  type SubscriberPageSize,
  type SubscriberSortField,
} from './subscriber-list-query';
import type { SubscriberFilters } from './types';

type WriteOptions = { replace?: boolean };

export type SubscriberListQueryState = {
  query: SubscriberListQuery;
  canonicalSearch: string;
  setPage: (page: number, options?: WriteOptions) => void;
  setSize: (size: SubscriberPageSize) => void;
  setSort: (field: SubscriberSortField) => void;
  setFilters: (filters: SubscriberFilters) => void;
  setProfile: (profile: string | null, options?: WriteOptions) => void;
  clearProfile: () => void;
  resetFilters: () => void;
};

export function useSubscriberListQuery(): SubscriberListQueryState {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentSearch = searchParams.toString() ? `?${searchParams.toString()}` : '';
  const query = useMemo(() => parseSubscriberListQuery(currentSearch), [currentSearch]);
  const canonicalSearch = useMemo(() => serializeSubscriberListQuery(query), [query]);

  /* Invalid or non-canonical links degrade to the safe parsed state on the first
   * render. The replacement only cleans the address bar; it is not a new
   * navigation and therefore cannot accumulate history entries. */
  useEffect(() => {
    if (canonicalSearch === currentSearch) return;
    setSearchParams(new URLSearchParams(canonicalSearch.slice(1)), { replace: true });
  }, [canonicalSearch, currentSearch, setSearchParams]);

  const write = useCallback((patch: SubscriberListPatch, options?: WriteOptions) => {
    const next = applySubscriberListPatch(query, patch);
    const nextSearch = serializeSubscriberListQuery(next);
    if (nextSearch === canonicalSearch) return;
    setSearchParams(new URLSearchParams(nextSearch.slice(1)), options);
  }, [canonicalSearch, query, setSearchParams]);

  const setPage = useCallback((page: number, options?: WriteOptions) => {
    write({ page }, options);
  }, [write]);

  const setSize = useCallback((size: SubscriberPageSize) => {
    write({ size });
  }, [write]);

  const setSort = useCallback((field: SubscriberSortField) => {
    /* Preserve the existing header toggle: same field flips direction, a new
     * field starts ascending. The page reset is part of the same transition. */
    const order = query.sort === field && query.order === 'asc' ? 'desc' : 'asc';
    write({ sort: field, order });
  }, [query.order, query.sort, write]);

  const setFilters = useCallback((filters: SubscriberFilters) => {
    write({ filters });
  }, [write]);

  const setProfile = useCallback((profile: string | null, options?: WriteOptions) => {
    write({ profile }, options);
  }, [write]);

  const clearProfile = useCallback(() => {
    write({ profile: null }, { replace: true });
  }, [write]);

  const resetFilters = useCallback(() => {
    write({
      filters: {
        access: 'all',
        contract: 'all',
        provisioning: 'all',
        planId: '',
        balance: 'all',
      },
    });
  }, [write]);

  return useMemo(() => ({
    query,
    canonicalSearch,
    setPage,
    setSize,
    setSort,
    setFilters,
    setProfile,
    clearProfile,
    resetFilters,
  }), [
    query,
    canonicalSearch,
    setPage,
    setSize,
    setSort,
    setFilters,
    setProfile,
    clearProfile,
    resetFilters,
  ]);
}