import { useCallback, useEffect, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { getJsonWithSignal, isAbortError } from './read-client';

type SharedRead = { consumers: Set<symbol>; controller?: AbortController };
const cacheReads = new WeakMap<object, Map<string, SharedRead>>();
function readsFor(cache: object) {
  let reads = cacheReads.get(cache);
  if (!reads) { reads = new Map(); cacheReads.set(cache, reads); }
  return reads;
}
function readFor(reads: Map<string, SharedRead>, path: string) {
  let read = reads.get(path);
  if (!read) { read = { consumers: new Set() }; reads.set(path, read); }
  return read;
}

/* A cancelled read is not a failure and not a value: SWR must settle the request
 * without inventing data or an error. Resolving with whatever the cache already
 * holds keeps valid data intact, and resolving for the first time leaves the
 * consumer idle rather than permanently loading. The cancellation itself never
 * becomes a retained pending Promise. */
function abortFallback<T>(cache: object, key: string): T | undefined {
  const cached = (cache as { get?: (key: string) => { data?: T } | undefined }).get?.(key);
  return cached?.data;
}

export function useBoundedRead<T>(path: string | null, refreshInterval = 0) {
  const { cache } = useSWRConfig();
  const reads = readsFor(cache);
  const consumer = useRef(Symbol('bounded-read')).current;
  const fetcher = useCallback(async (key: string) => {
    const read = readFor(reads, key);
    read.controller?.abort();
    const controller = new AbortController();
    read.controller = controller;
    try {
      return await getJsonWithSignal<T>(key, controller.signal);
    } catch (err: unknown) {
      if (isAbortError(err)) return abortFallback<T>(cache, key) as T;
      throw err;
    } finally {
      if (read.controller === controller) {
        delete read.controller;
        if (!read.consumers.size && reads.get(key) === read) reads.delete(key);
      }
    }
  }, [reads, cache]);
  useEffect(() => {
    if (!path) return;
    const read = readFor(reads, path);
    read.consumers.add(consumer);
    return () => {
      read.consumers.delete(consumer);
      // StrictMode replays and shared consumers retain the same SWR request.
      queueMicrotask(() => {
        if (read.consumers.size || reads.get(path) !== read) return;
        read.controller?.abort();
        reads.delete(path);
      });
    };
  }, [consumer, path, reads]);
  return useSWR<T>(path, fetcher, {
    refreshInterval,
    keepPreviousData: false,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    // A read cancelled for its last consumer settled without data; the next
    // mount must be allowed to fetch it again instead of inheriting that empty
    // result for the default dedupe window.
    dedupingInterval: 0,
  });
}
