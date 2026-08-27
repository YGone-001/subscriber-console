import { useEffect, useMemo, type SetStateAction } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { useI18n } from '@/components/I18nProvider';
import { usePermissions } from '@/hooks/usePermissions';
import { fetcher } from '@/lib/fetcher';
import { userManagementActions, type UserOperation } from '@/lib/userManagementPolicy';
import type { UsersTableProps, UsersToolbarProps, UserDrawerProps } from '../components/types';
import type { SysUser, RoleKey, RoleFilter, StatusFilter, SortKey, SortDirection, DrawerMode } from '../types';
import { useUserCrud } from './useUserCrud';
import { useUserDrawer } from './useUserDrawer';
import { useUserSelection } from './useUserSelection';

type UserList = { items: SysUser[]; pagination: { page: number; pageSize: number; total: number; totalPages: number }; stats: { total: number; active: number; administrators: number; locked: number }; assignableRoles: RoleKey[] };

export function useUsersPage() {
  const { user: currentUser, can, isLoading: authLoading } = usePermissions();
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const navigate = (changes: Record<string, string | number | null>, replace = false) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '' || value === 'all') next.delete(key);
      else next.set(key, String(value));
    }
    router[replace ? 'replace' : 'push'](`/users?${next}`, { scroll: false });
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
  const { data, error, isLoading, mutate: mutateList } = useSWR<UserList>(can('users.read') ? `/api/users?${query}` : null, fetcher);
  const users = useMemo(() => data?.items || [], [data?.items]);
  const selectedUsername = params.get('user');
  const rawMode = params.get('mode');
  const mode: DrawerMode = rawMode === 'create' && can('users.create') ? 'create' : selectedUsername ? rawMode === 'edit' || rawMode === 'resetPassword' ? rawMode : 'view' : 'closed';
  const drawer = useUserDrawer(users, selectedUsername, mode, (username, nextMode) => navigate({ user: username, mode: nextMode === 'closed' || nextMode === 'view' ? null : nextMode }, nextMode === 'closed'));
  const selection = useUserSelection(users, users, currentUser?.username);
  const canManage = (target: SysUser, operation: UserOperation) => !!currentUser && userManagementActions(currentUser, target).includes(operation);
  const eligible = selection.selectedUsers.filter((user) => canManage(user, 'disable'));
  const mutate = async () => { await Promise.all([mutateList(), drawer.mutateAudit()]); };
  const crud = useUserCrud({ users, filteredUsers: users, selectedUsers: selection.selectedUsers, mutableSelectedUsers: eligible,
    currentUsername: currentUser?.username, selectedUser: drawer.selectedUser, newForm: drawer.newForm, editForm: drawer.editForm,
    setEditForm: drawer.setEditForm, setDrawerMode: drawer.setDrawerMode, closeDrawer: drawer.closeDrawer,
    resetNewForm: drawer.resetNewForm, setSelectedUsernames: selection.setSelectedUsernames, bulkRole: selection.bulkRole, mutate, t, canManage });

  // A deletion/filter change may make a bookmarked page out of range. Keep URL and server result aligned.
  useEffect(() => {
    if (data && data.pagination.page !== page) {
      const next = new URLSearchParams(params.toString()); next.set('page', String(data.pagination.page));
      router.replace(`/users?${next}`, { scroll: false });
    }
  }, [data, page, params, router]);

  const openCreateDrawer = () => { crud.setNotice(null); crud.resetUsernameAvailability(); drawer.openCreateDrawer(); };
  const openDetails = (user: SysUser) => { drawer.setOpenMenuUsername(null); drawer.openDetails(user); };
  const startEdit = (user: SysUser) => { crud.setNotice(null); drawer.setOpenMenuUsername(null); drawer.startEdit(user); };
  const startPasswordReset = (user: SysUser) => { crud.setNotice(null); drawer.setOpenMenuUsername(null); drawer.startPasswordReset(user); };
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
    mutateAudit: async () => { await drawer.mutateAudit(); },
  } satisfies UserDrawerProps;
  return { canRead: can('users.read'), canCreate: can('users.create'), authLoading, stats: data?.stats, openCreateDrawer, t, toolbarProps, drawerProps, tableProps };
}
