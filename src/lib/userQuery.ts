import { normalizeGovernanceRole } from '@/lib/permissions';
import { UserManagementError } from '@/lib/userManagementPolicy';

export function escapeUserSearch(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export const USER_SORT_FIELDS = { username: 'username', displayName: 'displayName', role: 'role', status: 'status', createdAt: 'createdAt', lastLoginAt: 'security.lastLoginAt' } as const;
export type UserQuery = ReturnType<typeof parseUserQuery>;

export function parseUserQuery(params: URLSearchParams) {
  const invalid = () => { throw new UserManagementError('INVALID_QUERY', 400); };
  const allowed = new Set(['page', 'pageSize', 'search', 'q', 'role', 'status', 'sort', 'order']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) invalid();
  const number = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) return invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) return invalid();
    return value;
  };
  const role = params.get('role') || undefined;
  const status = params.get('status') || undefined;
  const sort = params.get('sort') || 'createdAt';
  const order = params.get('order') || 'desc';
  const search = (params.get('search') ?? params.get('q') ?? '').trim();
  if (role && !normalizeGovernanceRole(role)) invalid();
  if (status && !['active', 'disabled', 'locked'].includes(status)) invalid();
  if (!Object.hasOwn(USER_SORT_FIELDS, sort) || !['asc', 'desc'].includes(order) || search.length > 100) invalid();
  return { page: number('page', 1, 100000), pageSize: number('pageSize', 20, 100), role, status, sort: sort as keyof typeof USER_SORT_FIELDS, order: order as 'asc' | 'desc', search };
}
