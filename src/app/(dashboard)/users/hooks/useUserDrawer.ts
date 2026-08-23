import { useMemo, useState } from "react";
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

export function useUserDrawer(users: SysUser[], initialUsername: string | null = null) {
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(initialUsername ? "view" : "closed");
  const [detailTab, setDetailTab] = useState<DetailTab>("basic");
  const [newForm, setNewForm] = useState<NewUserForm>(DEFAULT_NEW_FORM);
  const [editForm, setEditForm] = useState<EditUserForm>(DEFAULT_EDIT_FORM);
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [newConfirmPasswordVisible, setNewConfirmPasswordVisible] = useState(false);
  const [editPasswordVisible, setEditPasswordVisible] = useState(false);
  const [selectedUsername, setSelectedUsername] = useState<string | null>(initialUsername);
  const [openMenuUsername, setOpenMenuUsername] = useState<string | null>(null);
  const selectedUser = useMemo(
    () => selectedUsername ? users.find((item) => item.username === selectedUsername) || null : null,
    [selectedUsername, users],
  );
  const auditUrl = drawerMode === "view" && detailTab === "activity" && selectedUser
    ? `/api/audit?target=${encodeURIComponent(selectedUser.username)}&limit=50`
    : null;
  const {
    data: auditData,
    error: auditError,
    isLoading: isAuditLoading,
    mutate: mutateAudit,
  } = useSWR<AuditLogResponse>(auditUrl, fetcher);

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
      role: normalizeRole(targetUser.role),
      status: normalizeStatus(targetUser.status),
      password: "",
    });
    setEditPasswordVisible(false);
  };

  const openCreateDrawer = () => {
    resetNewForm();
    setSelectedUsername(null);
    setDrawerMode("create");
    setDetailTab("basic");
  };

  const openDetails = (targetUser: SysUser) => {
    setSelectedUsername(targetUser.username);
    setDrawerMode("view");
    setDetailTab("basic");
    fillEditForm(targetUser);
  };

  const startEdit = (targetUser: SysUser) => {
    setSelectedUsername(targetUser.username);
    setDrawerMode("edit");
    setDetailTab("basic");
    fillEditForm(targetUser);
  };

  const startPasswordReset = (targetUser: SysUser) => {
    setSelectedUsername(targetUser.username);
    setDrawerMode("resetPassword");
    setDetailTab("basic");
    fillEditForm(targetUser);
  };

  const closeDrawer = () => {
    setSelectedUsername(null);
    setDrawerMode("closed");
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
