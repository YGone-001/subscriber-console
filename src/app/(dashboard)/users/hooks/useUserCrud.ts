import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { KeyedMutator } from "swr";
import type { I18nContextType } from "@/components/I18nProvider";
import { toCsvRow } from "@/lib/csv";
import { isProtectedSystemUser } from "@/lib/userAccessManagement";
import {
  USERNAME_PATTERN,
  VALID_ROLES,
  VALID_STATUS,
  type BulkAction,
  type BulkProgressState,
  type EditUserForm,
  type NewUserForm,
  type Notice,
  type PendingBulkAction,
  type PendingStatusChange,
  type PendingUpdate,
  type RoleKey,
  type SysUser,
  type UserStatus,
  type UsernameAvailability,
} from "../types";
import { normalizeRole, normalizeStatus } from "../utils";

type UsersResponse = { users: SysUser[] };
type UpdatePayload = { role?: RoleKey; status?: UserStatus; password?: string };

interface UseUserCrudOptions {
  users: SysUser[];
  filteredUsers: SysUser[];
  selectedUsers: SysUser[];
  mutableSelectedUsers: SysUser[];
  currentUsername?: string;
  selectedUser: SysUser | null;
  newForm: NewUserForm;
  editForm: EditUserForm;
  setEditForm: Dispatch<SetStateAction<EditUserForm>>;
  setDrawerMode: (mode: "closed" | "view" | "create" | "edit") => void;
  closeDrawer: () => void;
  resetNewForm: () => void;
  setSelectedUsernames: Dispatch<SetStateAction<string[]>>;
  bulkRole: RoleKey;
  mutate: KeyedMutator<UsersResponse>;
  t: I18nContextType["t"];
}

async function readError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export function useUserCrud(options: UseUserCrudOptions) {
  const {
    users,
    filteredUsers,
    selectedUsers,
    mutableSelectedUsers,
    currentUsername,
    selectedUser,
    newForm,
    editForm,
    setEditForm,
    setDrawerMode,
    closeDrawer,
    resetNewForm,
    setSelectedUsernames,
    bulkRole,
    mutate,
    t,
  } = options;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusChange | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<PendingBulkAction | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [confirmReason, setConfirmReason] = useState("");
  const [usernameAvailability, setUsernameAvailability] = useState<UsernameAvailability>("idle");
  const [bulkProgress, setBulkProgress] = useState<BulkProgressState | null>(null);
  const usernameCheckRequestRef = useRef(0);
  const bulkCancelRef = useRef(false);

  const isProtectedUser = (targetUser: SysUser) => isProtectedSystemUser(targetUser, currentUsername);

  const resetConfirmState = () => {
    setConfirmReason("");
    setPendingStatusChange(null);
    setPendingBulkAction(null);
    setPendingUpdate(null);
  };

  const getCreateError = () => {
    if (!USERNAME_PATTERN.test(newForm.username.trim())) return t("users_err_username");
    if (users.some((item) => item.username.toLowerCase() === newForm.username.trim().toLowerCase())) return t("users_username_taken");
    if (newForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newForm.email.trim())) return t("users_err_email");
    if (newForm.password.length < 8) return t("users_err_password");
    if (newForm.confirmPassword !== newForm.password) return t("users_err_password_match");
    if (!VALID_ROLES.includes(newForm.role)) return t("users_err_role");
    return "";
  };

  const resetUsernameAvailability = () => {
    usernameCheckRequestRef.current += 1;
    setUsernameAvailability("idle");
  };

  const checkUsernameAvailability = async (username: string) => {
    const normalizedUsername = username.trim();
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      setUsernameAvailability("invalid");
      return;
    }
    const requestId = usernameCheckRequestRef.current + 1;
    usernameCheckRequestRef.current = requestId;
    setUsernameAvailability("checking");
    try {
      const response = await fetch("/api/auth/users", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, t("users_username_check_error")));
      const body = await response.json() as UsersResponse;
      if (usernameCheckRequestRef.current !== requestId) return;
      const taken = body.users.some((item) => item.username.toLowerCase() === normalizedUsername.toLowerCase());
      setUsernameAvailability(taken ? "taken" : "available");
    } catch (requestError) {
      console.error(requestError);
      if (usernameCheckRequestRef.current === requestId) setUsernameAvailability("error");
    }
  };

  const getEditError = () => {
    if (!VALID_ROLES.includes(editForm.role)) return t("users_err_role");
    if (!VALID_STATUS.includes(editForm.status)) return t("users_err_status");
    if (editForm.password && editForm.password.length < 8) return t("users_err_password");
    return "";
  };

  const handleCreate = async () => {
    const validationError = getCreateError();
    if (validationError) {
      setNotice({ type: "error", text: validationError });
      return;
    }

    setSavingAction("create");
    try {
      const response = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newForm.username.trim(),
          displayName: newForm.displayName.trim() || undefined,
          email: newForm.email.trim() || undefined,
          password: newForm.password,
          role: newForm.role,
        }),
      });
      if (!response.ok) {
        setNotice({ type: "error", text: await readError(response, t("users_err_create")) });
        return;
      }
      resetNewForm();
      resetUsernameAvailability();
      closeDrawer();
      setNotice({ type: "success", text: t("users_msg_created") });
      await mutate();
    } catch (requestError) {
      console.error(requestError);
      setNotice({ type: "error", text: t("users_err_create") });
    } finally {
      setSavingAction(null);
    }
  };

  const submitUpdate = async (targetUser: SysUser, payload: UpdatePayload, reason: string) => {
    setSavingAction(`update:${targetUser.username}`);
    try {
      const response = await fetch(`/api/auth/users/${targetUser.username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Operation-Reason": reason },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setNotice({ type: "error", text: await readError(response, t("users_err_update")) });
        return;
      }
      setDrawerMode("view");
      setEditForm((current) => ({ ...current, password: "" }));
      setPendingUpdate(null);
      setConfirmReason("");
      setNotice({ type: "success", text: t("users_msg_updated") });
      await mutate();
    } catch (requestError) {
      console.error(requestError);
      setNotice({ type: "error", text: t("users_err_update") });
    } finally {
      setSavingAction(null);
    }
  };

  const handleUpdate = async () => {
    if (!selectedUser) return;
    const validationError = getEditError();
    if (validationError) {
      setNotice({ type: "error", text: validationError });
      return;
    }
    const roleChanged = editForm.role !== normalizeRole(selectedUser.role);
    const statusChanged = editForm.status !== normalizeStatus(selectedUser.status);
    if (isProtectedUser(selectedUser) && (roleChanged || statusChanged)) {
      setNotice({ type: "error", text: t("users_err_protected_status") });
      return;
    }
    const payload: UpdatePayload = { role: editForm.role, status: editForm.status };
    if (editForm.password) payload.password = editForm.password;
    if (roleChanged || statusChanged || editForm.password) {
      setPendingUpdate({
        username: selectedUser.username,
        payload,
        impact: t("users_update_impact", {
          role: roleChanged ? t(`users_${editForm.role}`) : t("users_no_change"),
          status: statusChanged ? t(`users_${editForm.status}`) : t("users_no_change"),
        }),
      });
      setConfirmReason("");
      return;
    }
    await submitUpdate(selectedUser, payload, "");
  };

  const handlePasswordReset = async () => {
    if (!selectedUser) return;
    if (editForm.password.length < 8) {
      setNotice({ type: "error", text: t("users_err_password") });
      return;
    }
    setPendingUpdate({
      username: selectedUser.username,
      payload: { password: editForm.password },
      impact: t("users_reset_password_impact", { username: selectedUser.username }),
    });
    setConfirmReason("");
  };

  const executeStatusChange = async () => {
    if (!pendingStatusChange) return;
    const targetUser = users.find((item) => item.username === pendingStatusChange.username);
    if (!targetUser) return;
    if (isProtectedUser(targetUser)) {
      setNotice({ type: "error", text: t("users_err_protected_status") });
      setPendingStatusChange(null);
      return;
    }
    setSavingAction(`status:${targetUser.username}`);
    try {
      const response = await fetch(`/api/auth/users/${targetUser.username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Operation-Reason": confirmReason.trim() },
        body: JSON.stringify({ role: normalizeRole(targetUser.role), status: pendingStatusChange.status }),
      });
      if (!response.ok) {
        setNotice({ type: "error", text: await readError(response, t("users_err_update")) });
        return;
      }
      setPendingStatusChange(null);
      setConfirmReason("");
      setNotice({ type: "success", text: t("users_msg_updated") });
      await mutate();
    } catch (requestError) {
      console.error(requestError);
      setNotice({ type: "error", text: t("users_err_update") });
    } finally {
      setSavingAction(null);
    }
  };

  const exportUsers = (items: SysUser[], filePrefix: string) => {
    const header = ["username", "displayName", "email", "role", "status", "lastLoginAt", "lastLoginIp", "createdAt", "createdBy", "description"];
    const csv = [
      toCsvRow(header),
      ...items.map((item) => toCsvRow([
        item.username,
        item.displayName,
        item.email,
        normalizeRole(item.role),
        normalizeStatus(item.status),
        item.lastLoginAt,
        item.lastLoginIp,
        item.createdAt,
        item.createdBy,
        item.description,
      ])),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice({ type: "success", text: t("users_export_ready", { count: items.length }) });
  };

  const requestBulkAction = (action: BulkAction) => {
    const usernames = mutableSelectedUsers.map((item) => item.username);
    if (usernames.length === 0) {
      setNotice({ type: "error", text: t("users_bulk_no_eligible") });
      return;
    }
    setPendingBulkAction({ action, usernames, role: action === "assignRole" ? bulkRole : undefined });
    setConfirmReason("");
  };

  const executeBulkAction = async () => {
    if (!pendingBulkAction) return;
    const action = pendingBulkAction;
    bulkCancelRef.current = false;
    setBulkProgress({
      action: action.action,
      items: action.usernames.map((username) => ({ username, status: "pending" })),
      cancelRequested: false,
      completed: false,
    });
    setPendingBulkAction(null);
    setSavingAction(`bulk:${action.action}`);
    for (const username of action.usernames) {
      if (bulkCancelRef.current) {
        setBulkProgress((current) => current ? {
          ...current,
          items: current.items.map((item) => item.status === "pending" ? { ...item, status: "cancelled" } : item),
        } : current);
        break;
      }
      setBulkProgress((current) => current ? {
        ...current,
        items: current.items.map((item) => item.username === username ? { ...item, status: "running", reason: undefined } : item),
      } : current);
      const targetUser = users.find((item) => item.username === username);
      if (!targetUser) {
        setBulkProgress((current) => current ? {
          ...current,
          items: current.items.map((item) => item.username === username ? { ...item, status: "failed", reason: t("users_bulk_missing_user") } : item),
        } : current);
        continue;
      }
      try {
        const response = await fetch(`/api/auth/users/${username}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-Operation-Reason": confirmReason.trim() },
          body: JSON.stringify({
            role: action.action === "assignRole" ? action.role || normalizeRole(targetUser.role) : normalizeRole(targetUser.role),
            status: action.action === "enable" ? "active" : action.action === "disable" ? "disabled" : normalizeStatus(targetUser.status),
          }),
        });
        const reason = response.ok ? undefined : await readError(response, t("users_bulk_default_failure"));
        setBulkProgress((current) => current ? {
          ...current,
          items: current.items.map((item) => item.username === username ? { ...item, status: response.ok ? "success" : "failed", reason } : item),
        } : current);
      } catch (requestError) {
        console.error(requestError);
        setBulkProgress((current) => current ? {
          ...current,
          items: current.items.map((item) => item.username === username ? { ...item, status: "failed", reason: t("users_bulk_network_failure") } : item),
        } : current);
      }
    }
    setConfirmReason("");
    setSelectedUsernames([]);
    setSavingAction(null);
    try {
      await mutate();
    } catch (requestError) {
      console.error(requestError);
    }
    setBulkProgress((current) => current ? {
      ...current,
      completed: true,
      cancelRequested: bulkCancelRef.current,
      items: current.items.map((item) => item.status === "pending" ? { ...item, status: "cancelled" } : item),
    } : current);
  };

  const cancelBulkAction = () => {
    bulkCancelRef.current = true;
    setBulkProgress((current) => current ? { ...current, cancelRequested: true } : current);
  };

  const closeBulkProgress = () => {
    setBulkProgress((current) => current?.completed ? null : current);
  };

  return {
    notice,
    setNotice,
    savingAction,
    usernameAvailability,
    checkUsernameAvailability,
    resetUsernameAvailability,
    pendingStatusChange,
    setPendingStatusChange,
    pendingBulkAction,
    pendingUpdate,
    bulkProgress,
    confirmReason,
    setConfirmReason,
    resetConfirmState,
    isProtectedUser,
    handleCreate,
    handleUpdate,
    handlePasswordReset,
    submitUpdate,
    executeStatusChange,
    requestBulkAction,
    executeBulkAction,
    cancelBulkAction,
    closeBulkProgress,
    exportFilteredUsers: () => exportUsers(filteredUsers, "system-users"),
    exportSelectedUsers: () => exportUsers(selectedUsers, "system-users-selected"),
  };
}
