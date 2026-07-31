import React from 'react';

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Trash2,
  Upload,
  User,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { toCsvRow } from "@/lib/csv";
import { ROLE_CAPABILITIES, type Capability, type CapabilityDecision } from "@/lib/permissions";
import {
  buildUserQueryString,
  getUserAccessStatusMeta,
  isBulkMutableUser,
  isProtectedSystemUser,
} from "@/lib/userAccessManagement";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";

import {
  SysUser, RoleKey, UserStatus, RoleFilter, StatusFilter, CreatedFilter, BinaryFilter,
  SortKey, SortDirection, DrawerMode, DetailTab, NewUserForm, EditUserForm,
  Notice, PendingStatusChange, PendingBulkAction, PendingUpdate, ApprovalMetricResponse,
  AuditLogResponse, BulkAction, VALID_ROLES, VALID_STATUS, PAGE_SIZE_OPTIONS,
  DEFAULT_NEW_FORM, DEFAULT_EDIT_FORM, USERNAME_PATTERN, ROLE_STYLE,
  
} from "../types";


import { normalizeRole, normalizeStatus, normalizePageSize, formatDateTime, displayValue, matchesCreatedFilter, isRoleFilter, isStatusFilter, isCreatedFilter, isBinaryFilter, isSortKey, isSortDirection } from "../utils";



function matchesDateRange(value: string | undefined, from: string, to: string) {
  if (!from && !to) return true;
  if (!value) return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  if (from) {
    const fromTime = new Date(`${from}T00:00:00.000`).getTime();
    if (Number.isFinite(fromTime) && time < fromTime) return false;
  }
  if (to) {
    const toTime = new Date(`${to}T23:59:59.999`).getTime();
    if (Number.isFinite(toTime) && time > toTime) return false;
  }
  return true;
}

function sortUsers(items: SysUser[], sortKey: SortKey, sortDirection: SortDirection) {
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    if (sortKey === "createdAt" || sortKey === "lastLoginAt") {
      const leftTime = left[sortKey] ? new Date(left[sortKey]).getTime() : 0;
      const rightTime = right[sortKey] ? new Date(right[sortKey]).getTime() : 0;
      return (leftTime - rightTime) * direction;
    }
    if (sortKey === "status") {
      return normalizeStatus(left.status).localeCompare(normalizeStatus(right.status)) * direction;
    }
    return left.username.localeCompare(right.username) * direction;
  });
}

function mapCapabilityDecision(decision: CapabilityDecision) {
  if (decision === "approval") return "approval";
  if (decision === "deny") return "deny";
  return "allow";
}

function getInitialQuery() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export function useUsersPage() {
  const { user: currentUser, isRoot } = useAuth();
  const { t } = useI18n();
  const { data, error, isLoading, mutate, isValidating } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const { data: approvalMetrics } = useSWR<ApprovalMetricResponse>(
    isRoot ? "/api/approvals?limit=1&status=pending" : null,
    fetcher,
  );

  const initialQuery = useMemo(getInitialQuery, []);
  const users = useMemo(() => data?.users || [], [data?.users]);
  const drawerRef = useRef<HTMLElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [pendingDeleteUsername, setPendingDeleteUsername] = useState<string | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusChange | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<PendingBulkAction | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [confirmReason, setConfirmReason] = useState("");

  const [searchInput, setSearchInput] = useState(initialQuery.get("q") || "");
  const [searchQuery, setSearchQuery] = useState(initialQuery.get("q") || "");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(
    isRoleFilter(initialQuery.get("role")) ? initialQuery.get("role") as RoleFilter : "all",
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    isStatusFilter(initialQuery.get("status")) ? initialQuery.get("status") as StatusFilter : "all",
  );
  const [createdFilter, setCreatedFilter] = useState<CreatedFilter>(
    isCreatedFilter(initialQuery.get("created")) ? initialQuery.get("created") as CreatedFilter : "all",
  );
  const [createdFrom, setCreatedFrom] = useState(initialQuery.get("createdFrom") || "");
  const [createdTo, setCreatedTo] = useState(initialQuery.get("createdTo") || "");
  const [loginFrom, setLoginFrom] = useState(initialQuery.get("loginFrom") || "");
  const [loginTo, setLoginTo] = useState(initialQuery.get("loginTo") || "");
  const [creatorFilter, setCreatorFilter] = useState(initialQuery.get("createdBy") || "");
  const [lockedFilter, setLockedFilter] = useState<BinaryFilter>(
    isBinaryFilter(initialQuery.get("locked")) ? initialQuery.get("locked") as BinaryFilter : "all",
  );
  const [neverLoginFilter, setNeverLoginFilter] = useState<BinaryFilter>(
    isBinaryFilter(initialQuery.get("neverLogin")) ? initialQuery.get("neverLogin") as BinaryFilter : "all",
  );
  const [sortKey, setSortKey] = useState<SortKey>(
    isSortKey(initialQuery.get("sort")) ? initialQuery.get("sort") as SortKey : "createdAt",
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    isSortDirection(initialQuery.get("dir")) ? initialQuery.get("dir") as SortDirection : "desc",
  );
  const [page, setPage] = useState(() => Math.max(1, Number(initialQuery.get("page")) || 1));
  const [pageSize, setPageSize] = useState(() => normalizePageSize(initialQuery.get("pageSize")));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [drawerMode, setDrawerMode] = useState<DrawerMode>("closed");
  const [detailTab, setDetailTab] = useState<DetailTab>("basic");
  const [newForm, setNewForm] = useState<NewUserForm>(DEFAULT_NEW_FORM);
  const [editForm, setEditForm] = useState<EditUserForm>(DEFAULT_EDIT_FORM);
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [newConfirmPasswordVisible, setNewConfirmPasswordVisible] = useState(false);
  const [editPasswordVisible, setEditPasswordVisible] = useState(false);
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [selectedUsernames, setSelectedUsernames] = useState<string[]>([]);
  const [openMenuUsername, setOpenMenuUsername] = useState<string | null>(null);
  const [bulkRole, setBulkRole] = useState<RoleKey>("operator");
  const selectedUser = selectedUsername ? users.find((item) => item.username === selectedUsername) || null : null;
  const auditUrl = drawerMode === "view" && detailTab === "activity" && selectedUser
    ? `/api/audit?target=${encodeURIComponent(selectedUser.username)}&limit=50`
    : null;
  const { data: auditData, error: auditError, isLoading: isAuditLoading, mutate: mutateAudit } = useSWR<AuditLogResponse>(auditUrl, fetcher);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = buildUserQueryString({
      q: searchQuery,
      role: roleFilter,
      status: statusFilter,
      created: createdFilter,
      createdFrom,
      createdTo,
      loginFrom,
      loginTo,
      createdBy: creatorFilter,
      locked: lockedFilter,
      neverLogin: neverLoginFilter,
      sort: sortKey,
      dir: sortDirection,
      page,
      pageSize,
    });
    const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(null, "", nextUrl);
  }, [createdFilter, createdFrom, createdTo, creatorFilter, lockedFilter, loginFrom, loginTo, neverLoginFilter, page, pageSize, roleFilter, searchQuery, sortDirection, sortKey, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput);
      setPage(1);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (drawerMode === "closed") {
      lastFocusRef.current?.focus();
      return;
    }
    const firstFocusable = drawerRef.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    firstFocusable?.focus();
  }, [drawerMode]);

  const isProtectedUser = (targetUser: SysUser) => {
    return isProtectedSystemUser(targetUser, currentUser?.username);
  };

  const rememberFocus = () => {
    lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const resetConfirmState = () => {
    setConfirmReason("");
    setPendingDeleteUsername(null);
    setPendingStatusChange(null);
    setPendingBulkAction(null);
    setPendingUpdate(null);
  };

  const toggleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current: any) => current === "asc" ? "desc" : "asc");
    } else {
      setSortKey(nextKey);
      setSortDirection(nextKey === "username" || nextKey === "status" ? "asc" : "desc");
    }
    setPage(1);
  };

  const statusCounts = useMemo(() => {
    return users.reduce<Record<UserStatus, number>>((acc, item) => {
      const status = normalizeStatus(item.status);
      acc[status] += 1;
      return acc;
    }, { active: 0, disabled: 0 });
  }, [users]);

  const filteredUsers = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    const filtered = users.filter((item) => {
      const role = normalizeRole(item.role);
      const status = normalizeStatus(item.status);
      if (roleFilter !== "all" && role !== roleFilter) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (!matchesCreatedFilter(item.createdAt, createdFilter)) return false;
      if (!matchesDateRange(item.createdAt, createdFrom, createdTo)) return false;
      if (!matchesDateRange(item.lastLoginAt, loginFrom, loginTo)) return false;
      if (creatorFilter.trim() && !item.createdBy?.toLowerCase().includes(creatorFilter.trim().toLowerCase())) return false;
      if (lockedFilter !== "all") {
        const isLocked = item.locked === true;
        if (lockedFilter === "yes" && !isLocked) return false;
        if (lockedFilter === "no" && isLocked) return false;
      }
      if (neverLoginFilter !== "all") {
        const neverLoggedIn = !item.lastLoginAt;
        if (neverLoginFilter === "yes" && !neverLoggedIn) return false;
        if (neverLoginFilter === "no" && neverLoggedIn) return false;
      }
      if (!keyword) return true;
      return [
        item.username,
        item.displayName,
        item.email,
        item.description,
        item.createdBy,
        role,
        status,
      ].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    return sortUsers(filtered, sortKey, sortDirection);
  }, [createdFilter, createdFrom, createdTo, creatorFilter, lockedFilter, loginFrom, loginTo, neverLoginFilter, roleFilter, searchQuery, sortDirection, sortKey, statusFilter, users]);

  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedUsers = filteredUsers.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedUsers = users.filter((item) => selectedUsernames.includes(item.username));
  const mutableSelectedUsers = selectedUsers.filter((item) => isBulkMutableUser(item, currentUser?.username));
  const allPageSelected = pagedUsers.length > 0 && pagedUsers.every((item) => selectedUsernames.includes(item.username));
  const activeFilterCount = [
    searchQuery.trim() ? 1 : 0,
    roleFilter !== "all" ? 1 : 0,
    statusFilter !== "all" ? 1 : 0,
    createdFilter !== "all" ? 1 : 0,
    createdFrom || createdTo ? 1 : 0,
    loginFrom || loginTo ? 1 : 0,
    creatorFilter.trim() ? 1 : 0,
    lockedFilter !== "all" ? 1 : 0,
    neverLoginFilter !== "all" ? 1 : 0,
  ].reduce((sum, item) => sum + item, 0);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    setSelectedUsernames((current: any) => current.filter((username: string) => users.some((item) => item.username === username)));
  }, [users]);

  const readError = async (res: Response, fallback: string) => {
    try {
      const body = await res.json() as { error?: string };
      return body.error || fallback;
    } catch {
      return fallback;
    }
  };

  const getCreateError = () => {
    if (!USERNAME_PATTERN.test(newForm.username.trim())) return t("users_err_username");
    if (newForm.password.length < 8) return t("users_err_password");
    if (newForm.confirmPassword !== newForm.password) return t("users_err_password_match");
    if (!VALID_ROLES.includes(newForm.role)) return t("users_err_role");
    return "";
  };

  const getEditError = () => {
    if (!VALID_ROLES.includes(editForm.role)) return t("users_err_role");
    if (!VALID_STATUS.includes(editForm.status)) return t("users_err_status");
    if (editForm.password && editForm.password.length < 8) return t("users_err_password");
    return "";
  };

  const resetNewForm = () => {
    setNewForm(DEFAULT_NEW_FORM);
    setNewPasswordVisible(false);
    setNewConfirmPasswordVisible(false);
  };

  const resetEditForm = () => {
    setEditForm(DEFAULT_EDIT_FORM);
    setEditPasswordVisible(false);
  };

  const openCreateDrawer = () => {
    rememberFocus();
    resetNewForm();
    setSelectedUsername(null);
    setDrawerMode("create");
    setDetailTab("basic");
    setNotice(null);
  };

  const openDetails = (targetUser: SysUser) => {
    rememberFocus();
    setSelectedUsername(targetUser.username);
    setDrawerMode("view");
    setDetailTab("basic");
    setEditForm({
      role: normalizeRole(targetUser.role),
      status: normalizeStatus(targetUser.status),
      password: "",
    });
    setEditPasswordVisible(false);
  };

  const startEdit = (targetUser: SysUser) => {
    rememberFocus();
    setSelectedUsername(targetUser.username);
    setDrawerMode("edit");
    setDetailTab("basic");
    setEditForm({
      role: normalizeRole(targetUser.role),
      status: normalizeStatus(targetUser.status),
      password: "",
    });
    setEditPasswordVisible(false);
    setNotice(null);
  };

  const closeDrawer = () => {
    setSelectedUsername(null);
    setDrawerMode("closed");
    setDetailTab("basic");
    resetEditForm();
  };

  const clearFilters = () => {
    setSearchInput("");
    setSearchQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
    setCreatedFilter("all");
    setCreatedFrom("");
    setCreatedTo("");
    setLoginFrom("");
    setLoginTo("");
    setCreatorFilter("");
    setLockedFilter("all");
    setNeverLoginFilter("all");
    setPage(1);
  };

  const updateRoleFilter = (value: RoleFilter) => {
    setRoleFilter(value);
    setPage(1);
  };

  const updateStatusFilter = (value: StatusFilter) => {
    setStatusFilter(value);
    setPage(1);
  };

  const updateCreatedFilter = (value: CreatedFilter) => {
    setCreatedFilter(value);
    setPage(1);
  };

  const updateSearchQuery = (value: string) => {
    setSearchInput(value);
  };

  const handleCreate = async () => {
    const validationError = getCreateError();
    if (validationError) {
      setNotice({ type: "error", text: validationError });
      return;
    }

    setSavingAction("create");
    try {
      const res = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newForm.username.trim(),
          password: newForm.password,
          role: newForm.role,
        }),
      });

      if (res.ok) {
        resetNewForm();
        closeDrawer();
        setNotice({ type: "success", text: t("users_msg_created") });
        await mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_create")) });
      }
    } catch (requestError) {
      console.error(requestError);
      setNotice({ type: "error", text: t("users_err_create") });
    } finally {
      setSavingAction(null);
    }
  };

  const submitUpdate = async (
    targetUser: SysUser,
    payload: { role?: RoleKey; status?: UserStatus; password?: string },
    reason: string,
  ) => {
    setSavingAction(`update:${targetUser.username}`);
    try {
      const res = await fetch(`/api/auth/users/${targetUser.username}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Operation-Reason": reason,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setDrawerMode("view");
        setEditForm((current: any) => ({ ...current, password: "" }));
        setPendingUpdate(null);
        setConfirmReason("");
        setNotice({ type: "success", text: t("users_msg_updated") });
        await mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_update")) });
      }
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

    const protectedUser = isProtectedUser(selectedUser);
    const roleChanged = editForm.role !== normalizeRole(selectedUser.role);
    const statusChanged = editForm.status !== normalizeStatus(selectedUser.status);
    if (protectedUser && (roleChanged || statusChanged)) {
      setNotice({ type: "error", text: t("users_err_protected_status") });
      return;
    }

    const payload: { role?: RoleKey; status?: UserStatus; password?: string } = {
      role: editForm.role,
      status: editForm.status,
    };
    if (editForm.password) payload.password = editForm.password;

    const isDangerous = roleChanged || statusChanged || Boolean(editForm.password);
    if (isDangerous) {
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
      const res = await fetch(`/api/auth/users/${targetUser.username}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Operation-Reason": confirmReason.trim(),
        },
        body: JSON.stringify({
          role: normalizeRole(targetUser.role),
          status: pendingStatusChange.status,
        }),
      });

      if (res.ok) {
        setPendingStatusChange(null);
        setConfirmReason("");
        setNotice({ type: "success", text: t("users_msg_updated") });
        await mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_update")) });
      }
    } catch (requestError) {
      console.error(requestError);
      setNotice({ type: "error", text: t("users_err_update") });
    } finally {
      setSavingAction(null);
    }
  };

  const handleDelete = (username: string) => {
    const targetUser = users.find((item) => item.username === username);
    if (!targetUser || isProtectedUser(targetUser)) {
      setNotice({ type: "error", text: t("users_err_protected") });
      return;
    }
    setNotice(null);
    setPendingDeleteUsername(username);
    setConfirmReason("");
    setOpenMenuUsername(null);
  };

  const executeDelete = async () => {
    if (!pendingDeleteUsername) return;
    const username = pendingDeleteUsername;
    setSavingAction(`delete:${username}`);
    try {
      const res = await fetch(`/api/auth/users/${username}`, {
        method: "DELETE",
        headers: { "X-Operation-Reason": confirmReason.trim() },
      });
      if (res.ok) {
        setPendingDeleteUsername(null);
        setConfirmReason("");
        if (selectedUsername === username) closeDrawer();
        setNotice({ type: "success", text: t("users_msg_deleted") });
        await mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_delete")) });
      }
    } catch (requestError) {
      console.error(requestError);
      setNotice({ type: "error", text: t("users_err_delete") });
    } finally {
      setSavingAction(null);
    }
  };

  const exportUsers = (items: SysUser[], filePrefix: string) => {
    const header = [
      "username",
      "displayName",
      "email",
      "role",
      "status",
      "lastLoginAt",
      "lastLoginIp",
      "createdAt",
      "createdBy",
      "description",
    ];
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

    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice({ type: "success", text: t("users_export_ready", { count: items.length }) });
  };

  const exportFilteredUsers = () => {
    exportUsers(filteredUsers, "system-users");
  };

  const exportSelectedUsers = () => {
    exportUsers(selectedUsers, "system-users-selected");
  };

  const requestBulkAction = (action: BulkAction) => {
    const usernames = mutableSelectedUsers.map((item) => item.username);
    if (usernames.length === 0) {
      setNotice({ type: "error", text: t("users_bulk_no_eligible") });
      return;
    }
    setPendingBulkAction({
      action,
      usernames,
      role: action === "assignRole" ? bulkRole : undefined,
    });
    setConfirmReason("");
  };

  const executeBulkAction = async () => {
    if (!pendingBulkAction) return;

    const failures: Array<{ username: string; reason: string }> = [];
    let successCount = 0;
    setSavingAction(`bulk:${pendingBulkAction.action}`);

    for (const username of pendingBulkAction.usernames) {
      const targetUser = users.find((item) => item.username === username);
      if (!targetUser) {
        failures.push({ username, reason: t("users_bulk_missing_user") });
        continue;
      }

      try {
        let res: Response;
        if (pendingBulkAction.action === "delete") {
          res = await fetch(`/api/auth/users/${username}`, {
            method: "DELETE",
            headers: { "X-Operation-Reason": confirmReason.trim() },
          });
        } else {
          const nextRole = pendingBulkAction.action === "assignRole"
            ? pendingBulkAction.role || normalizeRole(targetUser.role)
            : normalizeRole(targetUser.role);
          const nextStatus = pendingBulkAction.action === "enable"
            ? "active"
            : pendingBulkAction.action === "disable"
              ? "disabled"
              : normalizeStatus(targetUser.status);
          res = await fetch(`/api/auth/users/${username}`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Operation-Reason": confirmReason.trim(),
            },
            body: JSON.stringify({ role: nextRole, status: nextStatus }),
          });
        }

        if (res.ok) {
          successCount += 1;
        } else {
          failures.push({ username, reason: await readError(res, t("users_bulk_default_failure")) });
        }
      } catch (requestError) {
        console.error(requestError);
        failures.push({ username, reason: t("users_bulk_network_failure") });
      }
    }

    setPendingBulkAction(null);
    setConfirmReason("");
    setSelectedUsernames([]);
    setSavingAction(null);
    await mutate();

    const failureText = failures.slice(0, 3).map((item) => `${item.username}: ${item.reason}`).join("; ");
    setNotice({
      type: failures.length > 0 ? "info" : "success",
      text: t("users_bulk_result", {
        success: successCount,
        failed: failures.length,
        reasons: failureText || t("users_bulk_no_failures"),
      }),
    });
  };

  const togglePageSelection = () => {
    const pageNames = pagedUsers.map((item) => item.username);
    if (allPageSelected) {
      setSelectedUsernames((current: any) => current.filter((username: string) => !pageNames.includes(username)));
      return;
    }
    setSelectedUsernames((current: any) => Array.from(new Set([...current, ...pageNames])));
  };

  const toggleUserSelection = (username: string) => {
    setSelectedUsernames((current: any) => (
      current.includes(username)
        ? current.filter((item: string) => item !== username)
        : [...current, username]
    ));
  };

  const renderRoleBadge = (roleValue: string) => {
    const role = normalizeRole(roleValue);
    const style = ROLE_STYLE[role];
    return (
      <span className="users-badge" style={{ background: style.bg, color: style.color }}>
        {t(`users_${role}`)}
      </span>
    );
  };

  const renderStatusBadge = (statusValue: string | undefined, locked?: boolean) => {
    const meta = getUserAccessStatusMeta(statusValue, locked);
    return (
      <span className={`users-badge ${meta.tone}`}>
        {t(meta.labelKey)}
      </span>
    );
  };

  const renderPasswordInput = (
    value: string,
    onChange: (value: string) => void,
    visible: boolean,
    setVisible: (value: boolean) => void,
    placeholder: string,
    onEnter?: () => void,
  ) => (
    <div className="users-password-field">
      <input
        type={visible ? "text" : "password"}
        className="form-input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.();
        }}
      />
      <button
        type="button"
        className="btn-icon users-password-toggle"
        onClick={() => setVisible(!visible)}
        title={visible ? t("users_hide_password") : t("users_show_password")}
        aria-label={visible ? t("users_hide_password") : t("users_show_password")}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );


  const detailTabs: Array<{ key: DetailTab; label: string }> = [
    { key: "basic", label: t("users_detail_tab_basic") },
    { key: "permissions", label: t("users_detail_tab_permissions") },
    { key: "login", label: t("users_detail_tab_login") },
    { key: "activity", label: t("users_detail_tab_activity") },
  ];


  const toolbarProps = {
    searchInput, updateSearchQuery, roleFilter, updateRoleFilter,
    statusFilter, updateStatusFilter, advancedOpen, setAdvancedOpen,
    activeFilterCount, mutate, isValidating, exportFilteredUsers,
    filteredUsers, createdFilter, updateCreatedFilter, createdFrom,
    setCreatedFrom, setPage, createdTo, setCreatedTo, loginFrom,
    setLoginFrom, loginTo, setLoginTo, creatorFilter, setCreatorFilter,
    lockedFilter, setLockedFilter, neverLoginFilter, setNeverLoginFilter,
    clearFilters
  };



  const drawerProps = {
    notice, setNotice, pendingDeleteUsername, savingAction, confirmReason,
    executeDelete, resetConfirmState, setConfirmReason, pendingStatusChange,
    executeStatusChange, pendingBulkAction, executeBulkAction, pendingUpdate,
    selectedUser, submitUpdate, drawerMode, closeDrawer, drawerRef,
    newForm, setNewForm, newPasswordVisible, setNewPasswordVisible,
    newConfirmPasswordVisible, setNewConfirmPasswordVisible, handleCreate,
    detailTabs, detailTab, setDetailTab, editForm, setEditForm,
    isProtectedUser, editPasswordVisible, setEditPasswordVisible,
    handleUpdate, openDetails, startEdit, handleDelete, renderPasswordInput,
    renderRoleBadge, renderStatusBadge, ROLE_CAPABILITIES, 
    mapCapabilityDecision, isAuditLoading, auditError, mutateAudit, auditData
  };
  const tableProps = {
    selectedUsernames, mutableSelectedUsers, requestBulkAction,
    bulkRole, setBulkRole, exportSelectedUsers, setSelectedUsernames,
    filteredUsers, users, allPageSelected, togglePageSelection,
    pagedUsers, toggleSort, sortKey, sortDirection,
    isLoading, error, mutate, openCreateDrawer, clearFilters,
    isProtectedUser, normalizeStatus, toggleUserSelection,
    openDetails, renderRoleBadge, renderStatusBadge,
    startEdit, openMenuUsername, setOpenMenuUsername,
    setPendingStatusChange, setConfirmReason, handleDelete,
    pageSize, setPageSize, setPage, PAGE_SIZE_OPTIONS,
    safePage, pageCount, normalizePageSize
  };
  return {
    isRoot,
    users,
    statusCounts,
    approvalMetrics,
    notice, setNotice,
    openCreateDrawer,
    t,
    toolbarProps,
    drawerProps,
    tableProps
  };
}
