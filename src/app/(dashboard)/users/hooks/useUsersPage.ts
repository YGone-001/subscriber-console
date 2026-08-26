import { useEffect, useMemo } from "react";
import useSWR from "swr";
import { useI18n } from "@/components/I18nProvider";
import { useAuth } from "@/hooks/useAuth";
import { fetcher } from "@/lib/fetcher";
import { buildUserQueryString } from "@/lib/userAccessManagement";
import type { UsersTableProps, UsersToolbarProps, UserDrawerProps } from "../components/types";
import type { SysUser, UserStatus } from "../types";
import { normalizePageSize, normalizeStatus } from "../utils";
import { useUserCrud } from "./useUserCrud";
import { useUserDrawer } from "./useUserDrawer";
import { useUserFilters } from "./useUserFilters";
import { useUserPagination } from "./useUserPagination";
import { useUserSelection } from "./useUserSelection";
import { useUserSort } from "./useUserSort";

function getInitialQuery() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function useUsersPage() {
  const { user: currentUser, isRoot } = useAuth();
  const { t } = useI18n();
  const { data, error, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const initialQuery = useMemo(() => getInitialQuery(), []);
  const users = useMemo(() => data?.users || [], [data?.users]);
  const filters = useUserFilters(users, initialQuery);
  const sort = useUserSort(initialQuery);
  const sortedUsers = useMemo(
    () => sort.sortUsers(filters.filteredUsers),
    [filters.filteredUsers, sort],
  );
  const resetKey = [
    filters.searchQuery,
    filters.roleFilter,
    filters.statusFilter,
    sort.sortKey,
    sort.sortDirection,
  ].join("|");
  const pagination = useUserPagination(sortedUsers, initialQuery, resetKey);
  const selection = useUserSelection(users, pagination.pagedItems, currentUser?.username);
  const drawer = useUserDrawer(users, initialQuery.get("user"));
  const crud = useUserCrud({
    users,
    filteredUsers: sortedUsers,
    selectedUsers: selection.selectedUsers,
    mutableSelectedUsers: selection.mutableSelectedUsers,
    currentUsername: currentUser?.username,
    selectedUser: drawer.selectedUser,
    newForm: drawer.newForm,
    editForm: drawer.editForm,
    setEditForm: drawer.setEditForm,
    setDrawerMode: drawer.setDrawerMode,
    closeDrawer: drawer.closeDrawer,
    resetNewForm: drawer.resetNewForm,
    setSelectedUsernames: selection.setSelectedUsernames,
    bulkRole: selection.bulkRole,
    mutate,
    t,
  });

  useEffect(() => {
    const query = buildUserQueryString({
      q: filters.searchQuery,
      role: filters.roleFilter,
      status: filters.statusFilter,
      sort: sort.sortKey,
      dir: sort.sortDirection,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });
    const params = new URLSearchParams(query);
    if (drawer.selectedUsername && drawer.drawerMode !== "closed" && drawer.drawerMode !== "create") params.set("user", drawer.selectedUsername);
    const nextQuery = params.toString();
    const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    window.history.replaceState(null, "", nextUrl);
  }, [drawer.drawerMode, drawer.selectedUsername, filters.roleFilter, filters.searchQuery, filters.statusFilter, pagination.page, pagination.pageSize, sort.sortDirection, sort.sortKey]);

  const statusCounts = useMemo(() => users.reduce<Record<UserStatus, number>>((counts, item) => {
    counts[normalizeStatus(item.status)] += 1;
    return counts;
  }, { active: 0, disabled: 0, locked: 0 }), [users]);

  const openCreateDrawer = () => {
    crud.setNotice(null);
    crud.resetUsernameAvailability();
    drawer.openCreateDrawer();
  };
  const openDetails = (user: SysUser) => {
    drawer.setOpenMenuUsername(null);
    drawer.openDetails(user);
  };
  const startEdit = (user: SysUser) => {
    crud.setNotice(null);
    drawer.setOpenMenuUsername(null);
    drawer.startEdit(user);
  };
  const startPasswordReset = (user: SysUser) => {
    crud.setNotice(null);
    drawer.setOpenMenuUsername(null);
    drawer.startPasswordReset(user);
  };
  const toolbarProps = {
    searchInput: filters.searchInput,
    updateSearchQuery: filters.updateSearchQuery,
    roleFilter: filters.roleFilter,
    updateRoleFilter: filters.updateRoleFilter,
    statusFilter: filters.statusFilter,
    updateStatusFilter: filters.updateStatusFilter,
  } satisfies UsersToolbarProps;

  const tableProps = {
    selectedUsernames: selection.selectedUsernames,
    mutableSelectedCount: selection.mutableSelectedUsers.length,
    requestBulkAction: crud.requestBulkAction,
    bulkRole: selection.bulkRole,
    setBulkRole: selection.setBulkRole,
    exportSelectedUsers: crud.exportSelectedUsers,
    clearSelection: () => selection.setSelectedUsernames([]),
    filteredUsers: sortedUsers,
    users,
    allPageSelected: selection.allPageSelected,
    togglePageSelection: selection.togglePageSelection,
    pagedUsers: pagination.pagedItems,
    toggleSort: sort.toggleSort,
    sortKey: sort.sortKey,
    sortDirection: sort.sortDirection,
    isLoading,
    error,
    refresh: () => { void mutate(); },
    openCreateDrawer,
    clearFilters: filters.clearFilters,
    isProtectedUser: crud.isProtectedUser,
    toggleUserSelection: selection.toggleUserSelection,
    openDetails,
    startEdit,
    startPasswordReset,
    openMenuUsername: drawer.openMenuUsername,
    setOpenMenuUsername: drawer.setOpenMenuUsername,
    setPendingStatusChange: crud.setPendingStatusChange,
    setConfirmReason: crud.setConfirmReason,
    pageSize: pagination.pageSize,
    setPageSize: (value: number) => pagination.setPageSize(normalizePageSize(String(value))),
    setPage: pagination.setPage,
    safePage: pagination.safePage,
    pageCount: pagination.pageCount,
  } satisfies UsersTableProps;

  const drawerProps = {
    notice: crud.notice,
    setNotice: crud.setNotice,
    savingAction: crud.savingAction,
    confirmReason: crud.confirmReason,
    resetConfirmState: crud.resetConfirmState,
    setConfirmReason: crud.setConfirmReason,
    pendingStatusChange: crud.pendingStatusChange,
    executeStatusChange: crud.executeStatusChange,
    pendingBulkAction: crud.pendingBulkAction,
    executeBulkAction: crud.executeBulkAction,
    bulkProgress: crud.bulkProgress,
    cancelBulkAction: crud.cancelBulkAction,
    closeBulkProgress: crud.closeBulkProgress,
    pendingUpdate: crud.pendingUpdate,
    selectedUser: drawer.selectedUser,
    submitUpdate: crud.submitUpdate,
    drawerMode: drawer.drawerMode,
    closeDrawer: drawer.closeDrawer,
    newForm: drawer.newForm,
    setNewForm: drawer.setNewForm,
    newPasswordVisible: drawer.newPasswordVisible,
    setNewPasswordVisible: drawer.setNewPasswordVisible,
    newConfirmPasswordVisible: drawer.newConfirmPasswordVisible,
    setNewConfirmPasswordVisible: drawer.setNewConfirmPasswordVisible,
    handleCreate: crud.handleCreate,
    usernameAvailability: crud.usernameAvailability,
    checkUsernameAvailability: crud.checkUsernameAvailability,
    resetUsernameAvailability: crud.resetUsernameAvailability,
    detailTab: drawer.detailTab,
    setDetailTab: drawer.setDetailTab,
    editForm: drawer.editForm,
    setEditForm: drawer.setEditForm,
    isProtectedUser: crud.isProtectedUser,
    editPasswordVisible: drawer.editPasswordVisible,
    setEditPasswordVisible: drawer.setEditPasswordVisible,
    handleUpdate: crud.handleUpdate,
    handlePasswordReset: crud.handlePasswordReset,
    openDetails,
    startEdit,
    startPasswordReset,
    isAuditLoading: drawer.isAuditLoading,
    auditError: drawer.auditError,
    mutateAudit: async () => { await drawer.mutateAudit(); },
    auditData: drawer.auditData,
  } satisfies UserDrawerProps;

  return {
    isRoot,
    users,
    statusCounts,
    openCreateDrawer,
    t,
    toolbarProps,
    drawerProps,
    tableProps,
  };
}
