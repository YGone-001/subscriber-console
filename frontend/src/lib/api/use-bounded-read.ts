import { useCallback, useEffect, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { getJsonWithSignal } from './read-client';

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

export function useBoundedRead<T>(path: string | null, refreshInterval = 0) {
  const { cache } = useSWRConfig();
  const reads = readsFor(cache);
  const consumer = useRef(Symbol('bounded-read')).current;
  const fetcher = useCallback(async (key: string) => {
    const read = readFor(reads, key);
    read.controller?.abort();
    const controller = new AbortController();
    read.controller = controller;
    try { return await getJsonWithSignal<T>(key, controller.signal); }
    finally {
      if (read.controller === controller) {
        delete read.controller;
        if (!read.consumers.size && reads.get(key) === read) reads.delete(key);
      }
    }
  }, [reads]);
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
  return useSWR<T>(path, fetcher, { refreshInterval, keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false });
}
