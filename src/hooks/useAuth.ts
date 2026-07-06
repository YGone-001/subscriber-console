'use client';

import useSWR from 'swr';

export interface User {
  username: string;
  role: 'root' | 'operator' | 'viewer';
  status?: string;
  createdAt?: string;
}

const fetcher = (url: string) => fetch(url).then(r => r.json());

export function useAuth() {
  const { data, error, isLoading, mutate } = useSWR<User>('/api/auth/me', fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false
  });

  return {
    user: data,
    isLoading,
    isError: !!error,
    isRoot: data?.role === 'root',
    isOperator: data?.role === 'operator',
    isViewer: data?.role === 'viewer',
    canEditSubscribers: data?.role === 'root' || data?.role === 'operator',
    canEditTemplates: data?.role === 'root',
    mutate
  };
}
