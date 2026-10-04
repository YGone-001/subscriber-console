import useSWR from 'swr';
import { getJson } from './read-client';

export function useRead<T>(path: string | null) {
  return useSWR<T>(path, getJson, { keepPreviousData: true, revalidateOnFocus: false });
}
