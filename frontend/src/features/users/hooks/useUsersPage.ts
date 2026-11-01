/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/users/hooks/useUsersPage.ts
 *
 * Adaptations, all at the runtime boundary:
 *   - The historical App Router hooks replaced by React Router: `useRouter().push`
 *     / `.replace` become `useNavigate`, and `useSearchParams` now returns a tuple.
 *   - `usePermissions()` replaced by the current session provider plus the shared
 *     capability helper, so the same `can(...)` call sites keep working.
 *   - `useSWR(fetcher)` replaced by the current read client.
 *   - The `scroll: false` navigation option dropped; React Router owns scrolling.
 *
 * Everything below the data boundary is unchanged: the query string is still the
 * single source of truth for filters, sort, pagination and the open drawer, and a
 * server-clamped page is written back to the URL so a bookmarked out-of-range
 * page cannot desynchronise from the list.
 */
import { useEffect, useMemo, type SetStateAction } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../../providers/I18nProvider';
import { useAuth } from '../../../providers/AuthProvider';
import { hasPermission } from '../../../lib/permissions';
import { useRead } from '../../../lib/api/use-read';
import { currentListLocation, withReturnTo } from '../../../lib/return-to';
import { userManagementActions, type UserOperation } from '../../../lib/userManagementPolicy';
import type { UsersTableProps, UsersToolbarProps, UserDrawerProps } from '../components/types';
import type { SysUser, RoleKey, RoleFilter, StatusFilter, SortKey, SortDirection, DrawerMode } from '../types';
import { useUserCrud } from './useUserCrud';
import { useUserDrawer } from './useUserDrawer';
import { useUserSelection } from './useUserSelection';

type UserList = { items: SysUser[]; pagination: { page: number; pageSize: number; total: number; totalPages: number }; stats: { total: number; active: number; administrators: number; locked: number }; assignableRoles: RoleKey[] };

export function useUsersPage() {
  const { user: currentUser, state } = useAuth();
  const { t } = useI18n();
  const navigateTo = useNavigate();
  const [params] = useSearchParams();
  const authLoading = state === 'checking';
  const can = (permission: string) => hasPermission(currentUser, permission);

  const navigate = (changes: Record<string, string | number | null>, replace = false) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '' || value === 'all') next.delete(key);
      else next.set(key, String(value));
    }
    navigateTo(`/users?${next}`, { replace });
  };

  const search = params.get('q') || '';
  const role = (params.get('role') || 'all') as RoleFilter;
  const status = (params.get('status') || 'all') as StatusFilter;
  const sortKey = (params.get('sort') || 'createdAt') as SortKey;
  const sortDirection = (params.get('order') || params.get('dir') || 'desc') as SortDirection;
  const page = Number(params.get('page') || 1);
  const pageSize = Number(params.get('pageSize') || 10);
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort: sortKey, order: sortDirection });
  if (search) query.set('q', search);
  if (role !== 'all') query.set('role', role);
  if (status !== 'all') query.set('status', status);

  const { data, error, isLoading, mutate: mutateList } = useRead<UserList>(can('users.read') ? `/api/users?${query}` : null);
  const users = useMemo(() => data?.items || [], [data?.items]);
  /* The drawer is creation-only. Detail, edit and password reset are owned by
   * /users/:username, so stale `?user=` links cannot open a second detail form. */
  const rawMode = params.get('mode');
  const mode: DrawerMode = rawMode === 'create' && can('users.create') ? 'create' : 'closed';
  const drawer = useUserDrawer(users, null, mode, (_username, nextMode) => navigate({ user: null, mode: nextMode === 'create' ? 'create' : null }, nextMode === 'closed'));
  const selection = useUserSelection(users, users, currentUser?.username);
  const canManage = (target: SysUser, operation: UserOperation) => !!currentUser && userManagementActions(currentUser as never, target).includes(operation);
  const eligible = selection.selectedUsers.filter((user) => canManage(user, 'disable'));
  const mutate = async () => { await Promise.all([mutateList(), drawer.mutateDetail()]); };
  const crud = useUserCrud({
    users, filteredUsers: users, selectedUsers: selection.selectedUsers, mutableSelectedUsers: eligible,
    currentUsername: currentUser?.username, selectedUser: drawer.selectedUser, newForm: drawer.newForm, editForm: drawer.editForm,
    setEditForm: drawer.setEditForm, setDrawerMode: drawer.setDrawerMode, closeDrawer: drawer.closeDrawer,
    resetNewForm: drawer.resetNewForm, setSelectedUsernames: selection.setSelectedUsernames, bulkRole: selection.bulkRole, mutate, t, canManage,
  });

  /* A deletion or filter change may make a bookmarked page out of range. Keep URL and server result aligned. */
  useEffect(() => {
    if (data && data.pagination.page !== page) {
      const next = new URLSearchParams(params.toString());
      next.set('page', String(data.pagination.page));
      navigateTo(`/users?${next}`, { replace: true });
    }
  }, [data, page, params, navigateTo]);

  const listLocation = currentListLocation('/users', params.size > 0 ? `?${params.toString()}` : '');
  const detailPath = (username: string, mode?: 'edit' | 'passwordReset') => withReturnTo(
    `/users/${encodeURIComponent(username)}${mode ? `?mode=${mode}` : ''}`,
    listLocation,
  );

  const openCreateDrawer = () => { crud.setNotice(null); crud.resetUsernameAvailability(); drawer.openCreateDrawer(); };
  /* The route page is the single user-detail surface. The drawer is reserved
   * for creation, so list actions navigate instead of opening a second form. */
  const openDetails = (user: SysUser) => { drawer.setOpenMenuUsername(null); navigateTo(detailPath(user.username)); };
  const startEdit = (user: SysUser) => { crud.setNotice(null); drawer.setOpenMenuUsername(null); navigateTo(detailPath(user.username, 'edit')); };
  const startPasswordReset = (user: SysUser) => { crud.setNotice(null); drawer.setOpenMenuUsername(null); navigateTo(detailPath(user.username, 'passwordReset')); };
  const clearFilters = () => navigate({ q: null, role: null, status: null, page: 1 });
  const roles = data?.assignableRoles || [];

  const toolbarProps = {
    searchInput: search, updateSearchQuery: (q: string) => navigate({ q, page: 1 }), roleFilter: role,
    updateRoleFilter: (role: RoleFilter) => navigate({ role, page: 1 }), statusFilter: status,
    updateStatusFilter: (status: StatusFilter) => navigate({ status, page: 1 }), clearFilters,
  } satisfies UsersToolbarProps;

  const tableProps = {
    selectedUsernames: selection.selectedUsernames, mutableSelectedCount: eligible.length, requestBulkAction: crud.requestBulkAction,
    bulkRole: selection.bulkRole, setBulkRole: selection.setBulkRole, exportSelectedUsers: crud.exportSelectedUsers,
    clearSelection: () => selection.setSelectedUsernames([]), filteredUsers: users, users, allPageSelected: selection.allPageSelected,
    togglePageSelection: selection.togglePageSelection, pagedUsers: users, total: data?.pagination.total || 0, totalUsers: data?.stats.total || 0,
    toggleSort: (key: SortKey) => navigate({ sort: key, order: sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc', dir: null, page: 1 }),
    sortKey, sortDirection, isLoading, error, refresh: () => { void mutate(); }, openCreateDrawer, clearFilters,
    isProtectedUser: crud.isProtectedUser, toggleUserSelection: selection.toggleUserSelection, openDetails, startEdit, startPasswordReset,
    openMenuUsername: drawer.openMenuUsername, setOpenMenuUsername: drawer.setOpenMenuUsername,
    setPendingStatusChange: crud.setPendingStatusChange, setConfirmReason: crud.setConfirmReason,
    pageSize, setPageSize: (size: number) => navigate({ pageSize: size, page: 1 }),
    setPage: (update: SetStateAction<number>) => navigate({ page: typeof update === 'function' ? update(data?.pagination.page || page) : update }),
    safePage: data?.pagination.page || 1, pageCount: data?.pagination.totalPages || 1, canCreate: can('users.create'), canManage, assignableRoles: roles,
  } satisfies UsersTableProps;

  const drawerProps = {
    ...drawer, ...crud, openDetails, startEdit, startPasswordReset, assignableRoles: roles, canManage,
  } satisfies UserDrawerProps;

  return { canRead: can('users.read'), canCreate: can('users.create'), authLoading, stats: data?.stats, openCreateDrawer, t, toolbarProps, drawerProps, tableProps };
}
