'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { hasPermission, isSuperAdmin } from '@/lib/permissions';
import type { RoleKey } from '@/types/iam';
import type { GovernanceRole } from '@/types/governance';

export interface User {
  username: string;
  role: RoleKey;
  normalizedRole?: GovernanceRole;
  status?: string;
  createdAt?: string;
}

export function useAuth() {
  const { data, error, isLoading, mutate } = useSWR<User>('/api/auth/me', fetcher, {
    revalidateOnFocus: true,
    shouldRetryOnError: false
  });

  return {
    user: data,
    isLoading,
    isError: !!error,
    isRoot: isSuperAdmin(data?.role),
    isOperator: data?.role === 'operator',
    isViewer: data?.role === 'viewer',
    canEditSubscribers: hasPermission(data, 'subscribers.write'),
    canEditTemplates: hasPermission(data, 'profiles.write'),
    mutate
  };
}
