import { useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { getJsonWithSignal } from './read-client';

export function useBoundedRead<T>(path: string | null, refreshInterval = 0) {
  const requests = useRef(new Map<string,AbortController>());
  const fetcher = useCallback(async (key: string) => {
    requests.current.get(key)?.abort(); const controller = new AbortController(); requests.current.set(key,controller);
    try { return await getJsonWithSignal<T>(key,controller.signal); }
    finally { if (requests.current.get(key)===controller) requests.current.delete(key); }
  },[]);
  useEffect(() => { const active=requests.current; return () => { if (path) active.get(path)?.abort(); }; },[path]);
  return useSWR<T>(path,fetcher,{refreshInterval,keepPreviousData:false,revalidateOnFocus:false,shouldRetryOnError:false});
}
