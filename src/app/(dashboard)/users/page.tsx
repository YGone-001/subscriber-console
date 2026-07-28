"use client";

import { useEffect, useMemo, useState } from "react";
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
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";

interface SysUser {
  username: string;
  role: string;
  status: string;
  createdAt: string;
  createdBy: string;
  displayName?: string;
  email?: string;
  description?: string;
  lastLoginAt?: string;
  lastLoginIp?: string;
}

type ApprovalMetricResponse = {
  pending?: number;
};

type Notice = {
  type: "success" | "error" | "info";
  text: string;
};

type RoleKey = "root" | "operator" | "viewer";
type UserStatus = "active" | "disabled";
type RoleFilter = RoleKey | "all";
type StatusFilter = UserStatus | "all";
type CreatedFilter = "all" | "today" | "7d" | "30d";
type DrawerMode = "closed" | "view" | "create" | "edit";
type DetailTab = "basic" | "permissions" | "login" | "activity";

type NewUserForm = {
  username: string;
  password: string;
  confirmPassword: string;
  role: RoleKey;
};

type EditUserForm = {
  role: RoleKey;
  status: UserStatus;
  password: string;
};

type PendingStatusChange = {
  username: string;
  status: UserStatus;
};

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const VALID_ROLES: readonly RoleKey[] = ["root", "operator", "viewer"];
const VALID_STATUS: readonly UserStatus[] = ["active", "disabled"];
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

const DEFAULT_NEW_FORM: NewUserForm = {
  username: "",
  password: "",
  confirmPassword: "",
  role: "operator",
};

const DEFAULT_EDIT_FORM: EditUserForm = {
  role: "operator",
  status: "active",
  password: "",
};

const ROLE_STYLE: Record<RoleKey, { color: string; bg: string }> = {
  root: { color: "var(--danger)", bg: "rgba(231, 74, 59, 0.12)" },
  operator: { color: "#d97706", bg: "rgba(245, 158, 11, 0.14)" },
  viewer: { color: "var(--primary)", bg: "rgba(78, 115, 223, 0.12)" },
};

const STATUS_STYLE: Record<UserStatus, { color: string; bg: string }> = {
  active: { color: "var(--success)", bg: "rgba(28, 200, 138, 0.12)" },
  disabled: { color: "var(--text-muted)", bg: "rgba(100, 116, 139, 0.12)" },
};

function isRoleKey(value: string): value is RoleKey {
  return VALID_ROLES.includes(value as RoleKey);
}

function isUserStatus(value: string): value is UserStatus {
  return VALID_STATUS.includes(value as UserStatus);
}

function isRoleFilter(value: string | null): value is RoleFilter {
  return value === "all" || (typeof value === "string" && isRoleKey(value));
}

function isStatusFilter(value: string | null): value is StatusFilter {
  return value === "all" || (typeof value === "string" && isUserStatus(value));
}

function isCreatedFilter(value: string | null): value is CreatedFilter {
  return value === "all" || value === "today" || value === "7d" || value === "30d";
}

function normalizeRole(value: string): RoleKey {
  return isRoleKey(value) ? value : "viewer";
}

function normalizeStatus(value: string | undefined): UserStatus {
  return value && isUserStatus(value) ? value : "active";
}

function normalizePageSize(value: string | null): number {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.includes(parsed as typeof PAGE_SIZE_OPTIONS[number]) ? parsed : 10;
}

function formatDateTime(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

function displayValue(value?: string) {
  return value?.trim() || "--";
}

function matchesCreatedFilter(createdAt: string, filter: CreatedFilter) {
  if (filter === "all") return true;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  if (filter === "today") {
    return date.toDateString() === now.toDateString();
  }

  const days = filter === "7d" ? 7 : 30;
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  return date.getTime() >= since;
}

function getInitialQuery() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.search);
}

export default function UsersPage() {
  const { user: currentUser, isRoot } = useAuth();
  const { t } = useI18n();
  const { data, error, isLoading, mutate, isValidating } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const { data: approvalMetrics } = useSWR<ApprovalMetricResponse>(
    isRoot ? "/api/approvals?limit=1&status=pending" : null,
    fetcher,
  );

  const initialQuery = useMemo(getInitialQuery, []);
  const users = useMemo(() => data?.users || [], [data?.users]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [pendingDeleteUsername, setPendingDeleteUsername] = useState<string | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusChange | null>(null);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (createdFilter !== "all") params.set("created", createdFilter);
    if (page > 1) params.set("page", String(page));
    if (pageSize !== 10) params.set("pageSize", String(pageSize));

    const query = params.toString();
    const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(null, "", nextUrl);
  }, [createdFilter, page, pageSize, roleFilter, searchQuery, statusFilter]);

  const statusCounts = useMemo(() => {
    return users.reduce<Record<UserStatus, number>>((acc, item) => {
      const status = normalizeStatus(item.status);
      acc[status] += 1;
      return acc;
    }, { active: 0, disabled: 0 });
  }, [users]);

  const filteredUsers = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    return users.filter((item) => {
      const role = normalizeRole(item.role);
      const status = normalizeStatus(item.status);
      if (roleFilter !== "all" && role !== roleFilter) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (!matchesCreatedFilter(item.createdAt, createdFilter)) return false;
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
  }, [createdFilter, roleFilter, searchQuery, statusFilter, users]);

  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedUsers = filteredUsers.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedUser = selectedUsername ? users.find((item) => item.username === selectedUsername) || null : null;
  const allPageSelected = pagedUsers.length > 0 && pagedUsers.every((item) => selectedUsernames.includes(item.username));
  const activeFilterCount = [
    searchQuery.trim() ? 1 : 0,
    roleFilter !== "all" ? 1 : 0,
    statusFilter !== "all" ? 1 : 0,
    createdFilter !== "all" ? 1 : 0,
  ].reduce((sum, item) => sum + item, 0);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    setSelectedUsernames((current) => current.filter((username) => users.some((item) => item.username === username)));
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
    resetNewForm();
    setSelectedUsername(null);
    setDrawerMode("create");
    setDetailTab("basic");
    setNotice(null);
  };

  const openDetails = (targetUser: SysUser) => {
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
    setSearchQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
    setCreatedFilter("all");
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
    setSearchQuery(value);
    setPage(1);
  };

  const isProtectedUser = (targetUser: SysUser) => {
    return targetUser.username === "admin" || targetUser.username === currentUser?.username;
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

    setSavingAction(`update:${selectedUser.username}`);
    try {
      const payload: { role?: RoleKey; status?: UserStatus; password?: string } = {
        role: editForm.role,
        status: editForm.status,
      };
      if (editForm.password) payload.password = editForm.password;

      const res = await fetch(`/api/auth/users/${selectedUser.username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setDrawerMode("view");
        setEditForm((current) => ({ ...current, password: "" }));
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: normalizeRole(targetUser.role),
          status: pendingStatusChange.status,
        }),
      });

      if (res.ok) {
        setPendingStatusChange(null);
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
    setOpenMenuUsername(null);
  };

  const executeDelete = async () => {
    if (!pendingDeleteUsername) return;
    const username = pendingDeleteUsername;
    setSavingAction(`delete:${username}`);
    try {
      const res = await fetch(`/api/auth/users/${username}`, { method: "DELETE" });
      if (res.ok) {
        setPendingDeleteUsername(null);
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

  const exportFilteredUsers = () => {
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
      ...filteredUsers.map((item) => toCsvRow([
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
    anchor.download = `system-users-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice({ type: "success", text: t("users_export_ready", { count: filteredUsers.length }) });
  };

  const togglePageSelection = () => {
    const pageNames = pagedUsers.map((item) => item.username);
    if (allPageSelected) {
      setSelectedUsernames((current) => current.filter((username) => !pageNames.includes(username)));
      return;
    }
    setSelectedUsernames((current) => Array.from(new Set([...current, ...pageNames])));
  };

  const toggleUserSelection = (username: string) => {
    setSelectedUsernames((current) => (
      current.includes(username)
        ? current.filter((item) => item !== username)
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

  const renderStatusBadge = (statusValue: string | undefined) => {
    const status = normalizeStatus(statusValue);
    const style = STATUS_STYLE[status];
    return (
      <span className="users-badge" style={{ background: style.bg, color: style.color }}>
        {t(`users_${status}`)}
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

  const renderFilterTags = () => {
    const tags: Array<{ key: string; label: string; onRemove: () => void }> = [];
    if (searchQuery.trim()) {
      tags.push({ key: "q", label: `${t("users_filter_keyword")}: ${searchQuery.trim()}`, onRemove: () => updateSearchQuery("") });
    }
    if (roleFilter !== "all") {
      tags.push({ key: "role", label: `${t("users_role")}: ${t(`users_${roleFilter}`)}`, onRemove: () => updateRoleFilter("all") });
    }
    if (statusFilter !== "all") {
      tags.push({ key: "status", label: `${t("users_status")}: ${t(`users_${statusFilter}`)}`, onRemove: () => updateStatusFilter("all") });
    }
    if (createdFilter !== "all") {
      tags.push({ key: "created", label: `${t("users_created")}: ${t(`users_created_${createdFilter}`)}`, onRemove: () => updateCreatedFilter("all") });
    }

    if (tags.length === 0) return null;
    return (
      <div className="users-filter-tags" aria-label={t("users_filter_tags")}>
        {tags.map((tag) => (
          <button key={tag.key} type="button" onClick={tag.onRemove} title={t("users_remove_filter")}>
            {tag.label}
            <X size={13} />
          </button>
        ))}
        <button type="button" className="users-clear-tag" onClick={clearFilters}>
          {t("users_clear_filters")}
        </button>
      </div>
    );
  };

  if (!isRoot) {
    return (
      <div className="container animate-fade-in" style={{ padding: "3rem" }}>
        <div className="users-access-panel">
          <EmptyState
            icon={<Shield size={48} />}
            title={t("users_access_denied")}
            description={t("users_access_denied_desc")}
          />
        </div>
      </div>
    );
  }

  const detailTabs: Array<{ key: DetailTab; label: string }> = [
    { key: "basic", label: t("users_detail_tab_basic") },
    { key: "permissions", label: t("users_detail_tab_permissions") },
    { key: "login", label: t("users_detail_tab_login") },
    { key: "activity", label: t("users_detail_tab_activity") },
  ];

  return (
    <>
      <div className="users-page animate-fade-in">
        <header className="users-page-header">
          <div>
            <h1>{t("users_title")}</h1>
            <p>{t("users_subtitle")}</p>
          </div>
          <div className="users-header-actions">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setNotice({ type: "info", text: t("users_import_unavailable") })}
            >
              <Upload size={16} />
              {t("users_bulk_import")}
            </button>
            <button type="button" className="btn btn-primary" onClick={openCreateDrawer}>
              <Plus size={17} />
              {t("users_new")}
            </button>
          </div>
        </header>

        <section className="users-summary" aria-label={t("users_summary")}>
          <div className="users-metric">
            <span>{t("users_count_total")}</span>
            <strong>{users.length}</strong>
          </div>
          <div className="users-metric success">
            <span>{t("users_enabled")}</span>
            <strong>{statusCounts.active}</strong>
          </div>
          <div className="users-metric muted">
            <span>{t("users_disabled_locked")}</span>
            <strong>{statusCounts.disabled}</strong>
          </div>
          <button
            type="button"
            className="users-metric warning"
            onClick={() => setNotice({ type: "info", text: t("users_approval_center_reserved") })}
          >
            <span>{t("users_pending_approval")}</span>
            <strong>{approvalMetrics?.pending ?? 0}</strong>
          </button>
        </section>

        <section className="users-table-panel">
          <div className="users-toolbar">
            <div className="users-search">
              <Search size={16} />
              <input
                value={searchQuery}
                onChange={(event) => updateSearchQuery(event.target.value)}
                placeholder={t("users_search_ph")}
                aria-label={t("users_search_ph")}
              />
            </div>
            <div className="users-filter-group" aria-label={t("users_filters")}>
              <select className="form-input" value={roleFilter} onChange={(event) => updateRoleFilter(event.target.value as RoleFilter)}>
                <option value="all">{t("users_filter_all_roles")}</option>
                {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
              </select>
              <select className="form-input" value={statusFilter} onChange={(event) => updateStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">{t("users_filter_all_statuses")}</option>
                {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
              </select>
              <button
                type="button"
                className={advancedOpen ? "btn btn-outline active" : "btn btn-outline"}
                onClick={() => setAdvancedOpen((current) => !current)}
                aria-expanded={advancedOpen}
              >
                <SlidersHorizontal size={15} />
                {t("users_more_filters")}
                {activeFilterCount > 0 ? <span className="users-filter-count">{activeFilterCount}</span> : null}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => void mutate()} disabled={isValidating}>
                <RefreshCw size={15} className={isValidating ? "users-spin" : undefined} />
                {t("refresh")}
              </button>
              <button type="button" className="btn btn-outline" onClick={exportFilteredUsers} disabled={filteredUsers.length === 0}>
                <Download size={15} />
                {t("users_export")}
              </button>
            </div>
          </div>

          {advancedOpen ? (
            <div className="users-advanced-row">
              <label>
                <CalendarDays size={15} />
                <span>{t("users_created_filter")}</span>
                <select className="form-input" value={createdFilter} onChange={(event) => updateCreatedFilter(event.target.value as CreatedFilter)}>
                  <option value="all">{t("users_created_all")}</option>
                  <option value="today">{t("users_created_today")}</option>
                  <option value="7d">{t("users_created_7d")}</option>
                  <option value="30d">{t("users_created_30d")}</option>
                </select>
              </label>
              <span>{t("users_more_filters_hint")}</span>
            </div>
          ) : null}

          {renderFilterTags()}

          <div className="users-table-meta">
            <span>{t("users_count_filtered", { count: filteredUsers.length, total: users.length })}</span>
            <span>{t("users_selected_count", { count: selectedUsernames.length })}</span>
          </div>

          <div className="users-table-scroll">
            <table className="users-table">
              <thead>
                <tr>
                  <th className="users-select-col">
                    <input
                      type="checkbox"
                      aria-label={t("users_select_page")}
                      checked={allPageSelected}
                      onChange={togglePageSelection}
                      disabled={pagedUsers.length === 0}
                    />
                  </th>
                  <th className="users-user-col"><span><User size={15} /> {t("users_col_user")}</span></th>
                  <th>{t("users_contact")}</th>
                  <th>{t("users_role")}</th>
                  <th>{t("users_status")}</th>
                  <th>{t("users_last_login")}</th>
                  <th>{t("users_created")}</th>
                  <th>{t("users_detail_created_by")}</th>
                  <th className="users-actions-col">{t("users_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={9}><LoadingRows columns={9} rows={6} /></td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState
                        icon={<Shield size={44} />}
                        title={t("users_error_title")}
                        description={t("users_error_desc")}
                        action={
                          <button type="button" className="btn btn-outline" onClick={() => void mutate()}>
                            <RefreshCw size={15} />
                            {t("refresh")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState
                        icon={<UserCheck size={44} />}
                        title={t("users_empty")}
                        description={t("users_empty_desc")}
                        action={
                          <button type="button" className="btn btn-primary" onClick={openCreateDrawer}>
                            <Plus size={16} />
                            {t("users_new")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={9}>
                      <EmptyState
                        icon={<Search size={44} />}
                        title={t("users_no_match")}
                        description={t("users_no_match_desc")}
                        action={
                          <button type="button" className="btn btn-outline" onClick={clearFilters}>
                            <X size={15} />
                            {t("users_clear_filters")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : pagedUsers.map((item) => {
                  const isProtected = isProtectedUser(item);
                  const itemStatus = normalizeStatus(item.status);
                  return (
                    <tr key={item.username}>
                      <td className="users-select-col">
                        <input
                          type="checkbox"
                          aria-label={t("users_select_user", { username: item.username })}
                          checked={selectedUsernames.includes(item.username)}
                          onChange={() => toggleUserSelection(item.username)}
                        />
                      </td>
                      <td className="users-user-col">
                        <button type="button" className="users-identity-btn" onClick={() => openDetails(item)}>
                          <span className="users-avatar">{item.username.slice(0, 1).toUpperCase()}</span>
                          <span>
                            <strong>{item.username}</strong>
                            <small>{displayValue(item.displayName || item.description)}</small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className="users-contact-cell">
                          <Mail size={14} />
                          {displayValue(item.email)}
                        </span>
                      </td>
                      <td>{renderRoleBadge(item.role)}</td>
                      <td>{renderStatusBadge(item.status)}</td>
                      <td className="users-date-cell">
                        <span>{formatDateTime(item.lastLoginAt)}</span>
                        <small>{displayValue(item.lastLoginIp)}</small>
                      </td>
                      <td className="users-date-cell">{formatDateTime(item.createdAt)}</td>
                      <td>{displayValue(item.createdBy)}</td>
                      <td className="users-actions-col">
                        <div className="users-row-actions">
                          <button type="button" className="btn btn-ghost" onClick={() => openDetails(item)}>
                            <Eye size={15} />
                            {t("users_view")}
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => startEdit(item)}>
                            <Settings size={15} />
                            {t("edit")}
                          </button>
                          <div className="users-more">
                            <button
                              type="button"
                              className="btn-icon"
                              onClick={() => setOpenMenuUsername((current) => current === item.username ? null : item.username)}
                              aria-expanded={openMenuUsername === item.username}
                              title={t("users_more_actions")}
                              aria-label={t("users_more_actions")}
                            >
                              <MoreHorizontal size={17} />
                            </button>
                            {openMenuUsername === item.username ? (
                              <div className="users-more-menu">
                                <button type="button" onClick={() => { startEdit(item); setOpenMenuUsername(null); }}>
                                  <KeyRound size={15} />
                                  {t("users_reset_password")}
                                </button>
                                <button type="button" disabled title={t("users_not_available_stage")}>
                                  <LogOut size={15} />
                                  {t("users_force_logout")}
                                </button>
                                <button
                                  type="button"
                                  disabled={isProtected || itemStatus === "active"}
                                  onClick={() => { setPendingStatusChange({ username: item.username, status: "active" }); setOpenMenuUsername(null); }}
                                >
                                  <UserCheck size={15} />
                                  {t("users_enable_account")}
                                </button>
                                <button
                                  type="button"
                                  disabled={isProtected || itemStatus === "disabled"}
                                  onClick={() => { setPendingStatusChange({ username: item.username, status: "disabled" }); setOpenMenuUsername(null); }}
                                >
                                  <UserX size={15} />
                                  {t("users_disable_account")}
                                </button>
                                <button type="button" disabled title={t("users_not_available_stage")}>
                                  <Lock size={15} />
                                  {t("users_unlock_account")}
                                </button>
                                <button type="button" disabled title={t("users_not_available_stage")}>
                                  <ChevronDown size={15} />
                                  {t("users_copy_user")}
                                </button>
                                <button type="button" className="danger" disabled={isProtected} onClick={() => handleDelete(item.username)}>
                                  <Trash2 size={15} />
                                  {t("delete")}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <footer className="users-pagination">
            <label>
              {t("users_page_size")}
              <select
                className="form-input"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(normalizePageSize(event.target.value));
                  setPage(1);
                }}
              >
                {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <span>{t("users_page_info", { page: safePage, pages: pageCount })}</span>
            <div>
              <button type="button" className="btn btn-outline" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage <= 1}>
                {t("prev")}
              </button>
              <button type="button" className="btn btn-outline" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={safePage >= pageCount}>
                {t("next")}
              </button>
            </div>
          </footer>
        </section>
      </div>

      {notice ? (
        <OperationNotice
          presentation="modal"
          tone={notice.type === "success" ? "success" : notice.type === "info" ? "info" : "danger"}
          title={notice.type === "success" ? t("success") : notice.type === "info" ? t("info") : t("error")}
          message={notice.text}
          onClose={() => setNotice(null)}
        />
      ) : null}

      {pendingDeleteUsername ? (
        <ConfirmActionPanel
          presentation="modal"
          title={t("users_delete_confirm", { username: pendingDeleteUsername })}
          message={t("users_delete_desc")}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          isWorking={savingAction === `delete:${pendingDeleteUsername}`}
          onConfirm={executeDelete}
          onCancel={() => setPendingDeleteUsername(null)}
        />
      ) : null}

      {pendingStatusChange ? (
        <ConfirmActionPanel
          presentation="modal"
          tone={pendingStatusChange.status === "disabled" ? "warning" : "info"}
          title={t("users_status_confirm", { username: pendingStatusChange.username })}
          message={t(pendingStatusChange.status === "disabled" ? "users_status_disable_desc" : "users_status_enable_desc")}
          confirmLabel={pendingStatusChange.status === "disabled" ? t("users_disable_account") : t("users_enable_account")}
          cancelLabel={t("cancel")}
          isWorking={savingAction === `status:${pendingStatusChange.username}`}
          onConfirm={executeStatusChange}
          onCancel={() => setPendingStatusChange(null)}
        />
      ) : null}

      {drawerMode !== "closed" ? (
        <div className="users-drawer-layer" role="dialog" aria-modal="true" aria-label={t("users_drawer_title")}>
          <button type="button" className="users-drawer-backdrop" aria-label={t("cancel")} onClick={closeDrawer} />
          <aside className="users-drawer">
            <header className="users-drawer-header">
              <div>
                <span className="users-avatar large">
                  {drawerMode === "create" ? <Plus size={20} /> : selectedUser?.username.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <h2>{drawerMode === "create" ? t("users_drawer_create_title") : selectedUser?.username}</h2>
                  <p>{drawerMode === "create" ? t("users_create_panel_desc") : t("users_drawer_subtitle")}</p>
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={closeDrawer} aria-label={t("cancel")} title={t("cancel")}>
                <X size={18} />
              </button>
            </header>

            {drawerMode === "create" ? (
              <div className="users-drawer-body">
                <section className="users-form-section">
                  <h3>{t("users_form_basic")}</h3>
                  <label>
                    <span>{t("users_username")}</span>
                    <input
                      type="text"
                      className="form-input"
                      value={newForm.username}
                      onChange={(event) => setNewForm((current) => ({ ...current, username: event.target.value }))}
                      autoFocus
                    />
                  </label>
                </section>
                <section className="users-form-section">
                  <h3>{t("users_form_role")}</h3>
                  <label>
                    <span>{t("users_role")}</span>
                    <select
                      className="form-input"
                      value={newForm.role}
                      onChange={(event) => setNewForm((current) => ({ ...current, role: event.target.value as RoleKey }))}
                    >
                      {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
                    </select>
                  </label>
                </section>
                <section className="users-form-section">
                  <h3>{t("users_form_security")}</h3>
                  <label>
                    <span>{t("users_password_new")}</span>
                    {renderPasswordInput(
                      newForm.password,
                      (password) => setNewForm((current) => ({ ...current, password })),
                      newPasswordVisible,
                      setNewPasswordVisible,
                      t("users_password_new"),
                    )}
                  </label>
                  <label>
                    <span>{t("users_password_confirm")}</span>
                    {renderPasswordInput(
                      newForm.confirmPassword,
                      (confirmPassword) => setNewForm((current) => ({ ...current, confirmPassword })),
                      newConfirmPasswordVisible,
                      setNewConfirmPasswordVisible,
                      t("users_password_confirm"),
                      () => {
                        if (savingAction !== "create") void handleCreate();
                      },
                    )}
                  </label>
                </section>
              </div>
            ) : selectedUser ? (
              <>
                {drawerMode === "view" ? (
                  <nav className="users-drawer-tabs" aria-label={t("users_drawer_tabs")}>
                    {detailTabs.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        className={detailTab === tab.key ? "active" : undefined}
                        onClick={() => setDetailTab(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </nav>
                ) : null}

                <div className="users-drawer-body">
                  {drawerMode === "edit" ? (
                    <>
                      <section className="users-form-section">
                        <h3>{t("users_form_basic")}</h3>
                        <label>
                          <span>{t("users_username")}</span>
                          <input type="text" className="form-input" value={selectedUser.username} disabled />
                        </label>
                      </section>
                      <section className="users-form-section">
                        <h3>{t("users_form_role")}</h3>
                        <label>
                          <span>{t("users_role")}</span>
                          <select
                            className="form-input"
                            value={editForm.role}
                            onChange={(event) => setEditForm((current) => ({ ...current, role: event.target.value as RoleKey }))}
                            disabled={isProtectedUser(selectedUser)}
                          >
                            {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
                          </select>
                        </label>
                        <label>
                          <span>{t("users_status")}</span>
                          <select
                            className="form-input"
                            value={editForm.status}
                            onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as UserStatus }))}
                            disabled={isProtectedUser(selectedUser)}
                          >
                            {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
                          </select>
                        </label>
                      </section>
                      <section className="users-form-section">
                        <h3>{t("users_form_security")}</h3>
                        <label>
                          <span>{t("users_password_optional")}</span>
                          {renderPasswordInput(
                            editForm.password,
                            (password) => setEditForm((current) => ({ ...current, password })),
                            editPasswordVisible,
                            setEditPasswordVisible,
                            t("users_password_optional"),
                            () => {
                              if (savingAction !== `update:${selectedUser.username}`) void handleUpdate();
                            },
                          )}
                        </label>
                      </section>
                    </>
                  ) : detailTab === "basic" ? (
                    <section className="users-detail-section">
                      <h3>{t("users_detail_tab_basic")}</h3>
                      <dl>
                        <div>
                          <dt>{t("users_username")}</dt>
                          <dd>{selectedUser.username}</dd>
                        </div>
                        <div>
                          <dt>{t("users_display_name")}</dt>
                          <dd>{displayValue(selectedUser.displayName)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_email")}</dt>
                          <dd>{displayValue(selectedUser.email)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_role")}</dt>
                          <dd>{renderRoleBadge(selectedUser.role)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_status")}</dt>
                          <dd>{renderStatusBadge(selectedUser.status)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_detail_created_at")}</dt>
                          <dd>{formatDateTime(selectedUser.createdAt)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_detail_created_by")}</dt>
                          <dd>{displayValue(selectedUser.createdBy)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_last_login")}</dt>
                          <dd>{formatDateTime(selectedUser.lastLoginAt)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_last_login_ip")}</dt>
                          <dd>{displayValue(selectedUser.lastLoginIp)}</dd>
                        </div>
                        <div>
                          <dt>{t("users_account_note")}</dt>
                          <dd>{displayValue(selectedUser.description)}</dd>
                        </div>
                      </dl>
                    </section>
                  ) : (
                    <EmptyState
                      icon={detailTab === "permissions" ? <Shield size={42} /> : detailTab === "login" ? <Clock size={42} /> : <CheckCircle2 size={42} />}
                      title={t("users_no_data_title")}
                      description={t("users_no_data_desc")}
                    />
                  )}
                </div>
              </>
            ) : null}

            <footer className="users-drawer-footer">
              {drawerMode === "create" ? (
                <>
                  <button type="button" className="btn btn-outline" onClick={closeDrawer} disabled={savingAction === "create"}>
                    <X size={15} />
                    {t("cancel")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={savingAction === "create"}>
                    {savingAction === "create" ? <span className="spinner" /> : <Save size={15} />}
                    {t("save")}
                  </button>
                </>
              ) : drawerMode === "edit" && selectedUser ? (
                <>
                  <button type="button" className="btn btn-outline" onClick={() => openDetails(selectedUser)} disabled={savingAction === `update:${selectedUser.username}`}>
                    <X size={15} />
                    {t("cancel")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleUpdate} disabled={savingAction === `update:${selectedUser.username}`}>
                    {savingAction === `update:${selectedUser.username}` ? <span className="spinner" /> : <Save size={15} />}
                    {t("save")}
                  </button>
                </>
              ) : selectedUser ? (
                <>
                  <button
                    type="button"
                    className="btn btn-outline users-danger-action"
                    onClick={() => handleDelete(selectedUser.username)}
                    disabled={isProtectedUser(selectedUser) || pendingDeleteUsername != null}
                  >
                    <Trash2 size={15} />
                    {t("delete")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => startEdit(selectedUser)}>
                    <Settings size={15} />
                    {t("edit")}
                  </button>
                </>
              ) : null}
            </footer>
          </aside>
        </div>
      ) : null}

      <style dangerouslySetInnerHTML={{ __html: usersPageStyles }} />
    </>
  );
}

const usersPageStyles = `
  .users-page {
    min-height: 100%;
    padding: 24px;
    background: var(--background);
    max-width: 1880px;
    margin: 0 auto;
  }

  .users-access-panel,
  .users-table-panel,
  .users-summary {
    background: var(--surface);
    border: 1px solid var(--surface-border);
    border-radius: 8px;
  }

  .users-page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 20px;
  }

  .users-page-header h1 {
    margin: 0;
    background: none;
    -webkit-text-fill-color: currentColor;
    color: var(--text-main);
    font-size: 1.65rem;
    line-height: 1.2;
    letter-spacing: 0;
  }

  .users-page-header p {
    margin: 0.35rem 0 0;
    color: var(--text-muted);
    font-size: 0.92rem;
  }

  .users-header-actions,
  .users-filter-group,
  .users-row-actions,
  .users-drawer-footer,
  .users-pagination > div {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }

  .users-header-actions .btn,
  .users-filter-group .btn,
  .users-pagination .btn,
  .users-row-actions .btn {
    min-height: 36px;
    border-radius: 7px;
  }

  .users-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    overflow: hidden;
    margin-bottom: 20px;
  }

  .users-metric {
    min-height: 72px;
    display: grid;
    gap: 0.25rem;
    align-content: center;
    padding: 0.8rem 1rem;
    border: 0;
    border-right: 1px solid var(--surface-border);
    background: transparent;
    color: var(--text-main);
    text-align: left;
  }

  button.users-metric {
    cursor: pointer;
  }

  .users-metric:last-child {
    border-right: 0;
  }

  .users-metric.success strong {
    color: var(--success);
  }

  .users-metric.warning strong {
    color: #d97706;
  }

  .users-metric.muted strong {
    color: var(--text-muted);
  }

  button.users-metric:hover {
    background: color-mix(in srgb, var(--primary) 6%, transparent);
  }

  .users-metric span {
    color: var(--text-muted);
    font-size: 0.78rem;
    font-weight: 800;
  }

  .users-metric strong {
    color: currentColor;
    font-size: 1.35rem;
    line-height: 1;
  }

  .users-table-panel {
    overflow: hidden;
  }

  .users-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.85rem;
    padding: 1rem;
    border-bottom: 1px solid var(--surface-border);
  }

  .users-search {
    min-width: 320px;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-height: 36px;
    padding: 0 0.85rem;
    border: 1px solid var(--surface-border);
    border-radius: 7px;
    background: var(--surface-hover);
    color: var(--text-muted);
  }

  .users-search input {
    width: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-main);
    font-size: 0.9rem;
  }

  .users-filter-group {
    flex-wrap: wrap;
    color: var(--text-muted);
  }

  .users-filter-group .form-input,
  .users-pagination .form-input,
  .users-advanced-row .form-input {
    width: auto;
    min-width: 132px;
    min-height: 36px;
    padding: 0.45rem 0.7rem;
    font-size: 0.86rem;
    border-radius: 7px;
  }

  .users-filter-group .btn.active {
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 34%, var(--surface-border));
    background: color-mix(in srgb, var(--primary) 7%, var(--surface));
  }

  .users-filter-count {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    display: inline-grid;
    place-items: center;
    background: var(--primary);
    color: white;
    font-size: 0.72rem;
    font-weight: 800;
  }

  .users-advanced-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--surface-border);
    background: color-mix(in srgb, var(--primary) 4%, var(--surface));
  }

  .users-advanced-row label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--text-muted);
    font-size: 0.82rem;
    font-weight: 800;
  }

  .users-advanced-row > span {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .users-filter-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.75rem 1rem 0;
  }

  .users-filter-tags button {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border: 1px solid var(--surface-border);
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
  }

  .users-filter-tags .users-clear-tag {
    color: var(--primary);
  }

  .users-table-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .users-table-scroll {
    overflow: auto;
    max-height: calc(100vh - 340px);
    min-height: 330px;
  }

  .users-table {
    width: 100%;
    min-width: 1180px;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 0.9rem;
  }

  .users-table th,
  .users-table td {
    height: 54px;
    padding: 0.65rem 0.85rem;
    border-bottom: 1px solid var(--surface-border);
    text-align: left;
    vertical-align: middle;
    background: var(--surface);
  }

  .users-table th {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: 0.74rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .users-table tbody tr:hover td {
    background: var(--surface-hover);
  }

  .users-table th span {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .users-select-col {
    position: sticky;
    left: 0;
    z-index: 4;
    width: 48px;
    min-width: 48px;
    text-align: center !important;
  }

  .users-user-col {
    position: sticky;
    left: 48px;
    z-index: 4;
    min-width: 260px;
    box-shadow: 1px 0 0 var(--surface-border);
  }

  tbody .users-select-col,
  tbody .users-user-col {
    z-index: 2;
  }

  .users-actions-col {
    position: sticky;
    right: 0;
    z-index: 4;
    min-width: 210px;
    text-align: right !important;
    box-shadow: -1px 0 0 var(--surface-border);
  }

  tbody .users-actions-col {
    z-index: 2;
  }

  .users-identity-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    max-width: 100%;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-main);
    cursor: pointer;
    text-align: left;
  }

  .users-identity-btn span:last-child {
    display: grid;
    gap: 0.14rem;
    min-width: 0;
  }

  .users-identity-btn strong,
  .users-identity-btn small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .users-identity-btn strong {
    font-size: 0.92rem;
    font-weight: 800;
  }

  .users-identity-btn small,
  .users-date-cell small {
    color: var(--text-muted);
    font-size: 0.74rem;
  }

  .users-avatar {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    color: var(--primary);
    font-weight: 900;
    flex-shrink: 0;
  }

  .users-avatar.large {
    width: 42px;
    height: 42px;
  }

  .users-contact-cell,
  .users-date-cell {
    display: grid;
    gap: 0.16rem;
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .users-contact-cell {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .users-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 76px;
    padding: 0.28rem 0.65rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 800;
  }

  .users-row-actions {
    justify-content: flex-end;
  }

  .users-row-actions .btn-ghost {
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    padding: 0.45rem 0.55rem;
  }

  .users-row-actions .btn-ghost:hover {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 8%, transparent);
  }

  .users-more {
    position: relative;
  }

  .users-more-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    min-width: 176px;
    display: grid;
    padding: 0.35rem;
    border: 1px solid var(--surface-border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: 0 16px 36px -24px rgba(15, 23, 42, 0.7);
  }

  .users-more-menu button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    border: 0;
    border-radius: 6px;
    padding: 0.5rem 0.55rem;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    text-align: left;
    font-size: 0.84rem;
  }

  .users-more-menu button:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text-main);
  }

  .users-more-menu button:disabled {
    color: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.55;
  }

  .users-more-menu button.danger {
    color: var(--danger);
  }

  .users-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem 1rem;
    border-top: 1px solid var(--surface-border);
    color: var(--text-muted);
    font-size: 0.84rem;
  }

  .users-pagination label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .users-drawer-layer {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: flex;
    justify-content: flex-end;
  }

  .users-drawer-backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    background: rgba(15, 23, 42, 0.32);
    cursor: pointer;
  }

  .users-drawer {
    position: relative;
    width: min(520px, 100vw);
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-left: 1px solid var(--surface-border);
    box-shadow: -24px 0 48px -32px rgba(0, 0, 0, 0.45);
  }

  .users-drawer-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding: 1.25rem;
    border-bottom: 1px solid var(--surface-border);
  }

  .users-drawer-header > div {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    min-width: 0;
  }

  .users-drawer-header h2 {
    margin: 0;
    color: var(--text-main);
    font-size: 1.08rem;
    line-height: 1.25;
  }

  .users-drawer-header p {
    margin: 0.2rem 0 0;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .users-drawer-tabs {
    display: flex;
    gap: 0.35rem;
    padding: 0.75rem 1.25rem 0;
    border-bottom: 1px solid var(--surface-border);
    overflow-x: auto;
  }

  .users-drawer-tabs button {
    min-height: 34px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    white-space: nowrap;
    font-weight: 800;
    font-size: 0.82rem;
  }

  .users-drawer-tabs button.active {
    color: var(--primary);
    border-bottom-color: var(--primary);
  }

  .users-drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem;
    display: grid;
    align-content: start;
    gap: 1rem;
  }

  .users-detail-section,
  .users-form-section {
    display: grid;
    gap: 0.85rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--surface-border);
  }

  .users-detail-section:last-child,
  .users-form-section:last-child {
    border-bottom: 0;
  }

  .users-detail-section h3,
  .users-form-section h3 {
    margin: 0;
    color: var(--text-main);
    font-size: 0.9rem;
  }

  .users-detail-section dl {
    display: grid;
    gap: 0.8rem;
    margin: 0;
  }

  .users-detail-section dl > div {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    align-items: center;
    gap: 0.75rem;
  }

  .users-detail-section dt,
  .users-form-section label > span {
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .users-detail-section dd {
    min-width: 0;
    margin: 0;
    color: var(--text-main);
    overflow-wrap: anywhere;
  }

  .users-form-section label {
    display: grid;
    gap: 0.4rem;
  }

  .users-password-field {
    position: relative;
  }

  .users-password-field .form-input {
    padding-right: 2.45rem;
  }

  .users-password-toggle {
    position: absolute;
    top: 50%;
    right: 0.35rem;
    width: 1.85rem;
    height: 1.85rem;
    transform: translateY(-50%);
  }

  .users-drawer-footer {
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-top: 1px solid var(--surface-border);
    background: var(--surface);
  }

  .users-danger-action {
    color: var(--danger);
  }

  .users-spin {
    animation: spin 0.9s linear infinite;
  }

  @media (max-width: 1180px) {
    .users-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .users-toolbar {
      align-items: stretch;
      flex-direction: column;
    }
  }

  @media (max-width: 860px) {
    .users-page {
      padding: 1rem;
    }

    .users-page-header,
    .users-advanced-row,
    .users-pagination {
      align-items: stretch;
      flex-direction: column;
    }

    .users-header-actions,
    .users-filter-group {
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .users-search {
      min-width: 0;
    }

    .users-summary {
      grid-template-columns: 1fr;
    }

    .users-metric {
      border-right: 0;
      border-bottom: 1px solid var(--surface-border);
    }

    .users-metric:last-child {
      border-bottom: 0;
    }

    .users-detail-section dl > div {
      grid-template-columns: 1fr;
      align-items: start;
      gap: 0.35rem;
    }
  }
`;
