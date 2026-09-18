import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  DEFAULT_EDIT_FORM,
  DEFAULT_NEW_FORM,
  type AuditLogResponse,
  type DetailTab,
  type DrawerMode,
  type EditUserForm,
  type NewUserForm,
  type SysUser,
} from "../types";
import { normalizeRole, normalizeStatus } from "../utils";
import type { UserOperation } from '@/lib/userManagementPolicy';
import type { RoleKey } from '@/types/iam';

export function useUserDrawer(users: SysUser[], selectedUsername: string | null, drawerMode: DrawerMode, navigate: (username: string | null, mode: DrawerMode) => void) {
  const setDrawerMode = (mode: DrawerMode) => navigate(selectedUsername, mode);
  const [detailTab, setDetailTab] = useState<DetailTab>("basic");
  const [newForm, setNewForm] = useState<NewUserForm>(DEFAULT_NEW_FORM);
  const [editForm, setEditForm] = useState<EditUserForm>(DEFAULT_EDIT_FORM);
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [newConfirmPasswordVisible, setNewConfirmPasswordVisible] = useState(false);
  const [editPasswordVisible, setEditPasswordVisible] = useState(false);
  const [openMenuUsername, setOpenMenuUsername] = useState<string | null>(null);
  const {
    data: detail,
    error: auditError,
    isLoading: isAuditLoading,
    mutate: mutateAudit,
  } = useSWR<{ user: SysUser; actions: UserOperation[]; assignableRoles: RoleKey[]; activity: AuditLogResponse['logs'] }>(selectedUsername ? `/api/users/${encodeURIComponent(selectedUsername)}` : null, fetcher);
  const selectedUser = detail?.user ?? users.find((item) => item.username === selectedUsername) ?? null;
  const auditData = detail ? { logs: detail.activity, filteredTotal: detail.activity.length, totalScanned: detail.activity.length } : undefined;

  const resetNewForm = () => {
    setNewForm(DEFAULT_NEW_FORM);
    setNewPasswordVisible(false);
    setNewConfirmPasswordVisible(false);
  };

  const resetEditForm = () => {
    setEditForm(DEFAULT_EDIT_FORM);
    setEditPasswordVisible(false);
  };

  const fillEditForm = (targetUser: SysUser) => {
    setEditForm({
      displayName: targetUser.displayName || '',
      email: targetUser.email || '',
      role: normalizeRole(targetUser.role),
      status: normalizeStatus(targetUser.status),
      password: "",
    });
    setEditPasswordVisible(false);
  };

  const openCreateDrawer = () => {
    resetNewForm();
    navigate(null, 'create');
    setDetailTab("basic");
  };

  const openDetails = (targetUser: SysUser) => {
    navigate(targetUser.username, 'view');
    setDetailTab("basic");
    fillEditForm(targetUser);
  };

  const startEdit = (targetUser: SysUser) => {
    navigate(targetUser.username, 'edit');
    setDetailTab("basic");
    fillEditForm(targetUser);
  };

  const startPasswordReset = (targetUser: SysUser) => {
    navigate(targetUser.username, 'resetPassword');
    setDetailTab("basic");
    fillEditForm(targetUser);
  };

  const closeDrawer = () => {
    navigate(null, 'closed');
    setDetailTab("basic");
    resetEditForm();
  };

  return {
    drawerMode,
    setDrawerMode,
    detailTab,
    setDetailTab,
    newForm,
    setNewForm,
    editForm,
    setEditForm,
    newPasswordVisible,
    setNewPasswordVisible,
    newConfirmPasswordVisible,
    setNewConfirmPasswordVisible,
    editPasswordVisible,
    setEditPasswordVisible,
    selectedUsername,
    selectedUser,
    openMenuUsername,
    setOpenMenuUsername,
    resetNewForm,
    openCreateDrawer,
    openDetails,
    startEdit,
    startPasswordReset,
    closeDrawer,
    auditData,
    auditError,
    isAuditLoading,
    mutateAudit,
  };
}
