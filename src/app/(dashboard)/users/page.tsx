"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import {
  Activity,
  Clock,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Trash2,
  User,
  X,
} from "lucide-react";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";
import { ConfirmActionPanel, EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";

interface SysUser {
  username: string;
  role: string;
  status: string;
  createdAt: string;
  createdBy: string;
}

type Notice = {
  type: "success" | "error";
  text: string;
};

type RoleKey = "root" | "operator" | "viewer";
type UserStatus = "active" | "disabled";

type RoleFilter = RoleKey | "all";
type StatusFilter = UserStatus | "all";

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

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const VALID_ROLES: readonly RoleKey[] = ["root", "operator", "viewer"];
const VALID_STATUS: readonly UserStatus[] = ["active", "disabled"];

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

function normalizeRole(value: string): RoleKey {
  return isRoleKey(value) ? value : "viewer";
}

function normalizeStatus(value: string | undefined): UserStatus {
  return value && isUserStatus(value) ? value : "active";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

export default function UsersPage() {
  const { user: currentUser, isRoot } = useAuth();
  const { t } = useI18n();
  const { data, isLoading, mutate, isValidating } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);

  const users = useMemo(() => data?.users || [], [data?.users]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [pendingDeleteUsername, setPendingDeleteUsername] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState<NewUserForm>(DEFAULT_NEW_FORM);
  const [newPasswordVisible, setNewPasswordVisible] = useState(false);
  const [newConfirmPasswordVisible, setNewConfirmPasswordVisible] = useState(false);

  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [isEditingSelected, setIsEditingSelected] = useState(false);
  const [editForm, setEditForm] = useState<EditUserForm>(DEFAULT_EDIT_FORM);

  const roleCounts = useMemo(() => {
    return users.reduce<Record<RoleKey, number>>((acc, item) => {
      const role = normalizeRole(item.role);
      acc[role] += 1;
      return acc;
    }, { root: 0, operator: 0, viewer: 0 });
  }, [users]);

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
      if (!keyword) return true;
      return [
        item.username,
        item.createdBy,
        role,
        status,
      ].join(" ").toLowerCase().includes(keyword);
    });
  }, [roleFilter, searchQuery, statusFilter, users]);

  const selectedUser = selectedUsername
    ? users.find((item) => item.username === selectedUsername) || null
    : null;

  const hasActiveFilters = searchQuery.trim() !== "" || roleFilter !== "all" || statusFilter !== "all";

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

  const newFormError = isAdding ? getCreateError() : "";
  const editFormError = isEditingSelected ? getEditError() : "";

  const resetNewForm = () => {
    setNewForm(DEFAULT_NEW_FORM);
    setNewPasswordVisible(false);
    setNewConfirmPasswordVisible(false);
  };

  const openDetails = (targetUser: SysUser) => {
    setSelectedUsername(targetUser.username);
    setIsEditingSelected(false);
    setEditForm({
      role: normalizeRole(targetUser.role),
      status: normalizeStatus(targetUser.status),
      password: "",
    });
  };

  const startEdit = (targetUser: SysUser) => {
    setSelectedUsername(targetUser.username);
    setIsEditingSelected(true);
    setEditForm({
      role: normalizeRole(targetUser.role),
      status: normalizeStatus(targetUser.status),
      password: "",
    });
    setNotice(null);
  };

  const closeDrawer = () => {
    setSelectedUsername(null);
    setIsEditingSelected(false);
    setEditForm(DEFAULT_EDIT_FORM);
  };

  const clearFilters = () => {
    setSearchQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
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
        setIsAdding(false);
        resetNewForm();
        setNotice({ type: "success", text: t("users_msg_created") });
        await mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_create")) });
      }
    } catch (error) {
      console.error(error);
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
        setIsEditingSelected(false);
        setEditForm((current) => ({ ...current, password: "" }));
        setNotice({ type: "success", text: t("users_msg_updated") });
        await mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_update")) });
      }
    } catch (error) {
      console.error(error);
      setNotice({ type: "error", text: t("users_err_update") });
    } finally {
      setSavingAction(null);
    }
  };

  const handleDelete = (username: string) => {
    if (username === "admin" || username === currentUser?.username) {
      setNotice({ type: "error", text: t("users_err_protected") });
      return;
    }
    setNotice(null);
    setPendingDeleteUsername(username);
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
    } catch (error) {
      console.error(error);
      setNotice({ type: "error", text: t("users_err_delete") });
    } finally {
      setSavingAction(null);
    }
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
              onClick={() => void mutate()}
              disabled={isValidating}
            >
              <RefreshCw size={16} className={isValidating ? "users-spin" : undefined} />
              {t("refresh")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setIsAdding(true);
                setNotice(null);
              }}
              disabled={isAdding}
            >
              <Plus size={17} />
              {t("users_new")}
            </button>
          </div>
        </header>

        <section className="users-summary" aria-label={t("users_summary")}>
          <button type="button" className={roleFilter === "all" && statusFilter === "all" ? "users-metric active" : "users-metric"} onClick={() => { setRoleFilter("all"); setStatusFilter("all"); }}>
            <span>{t("users_count_total")}</span>
            <strong>{users.length}</strong>
          </button>
          {VALID_ROLES.map((role) => (
            <button key={role} type="button" className={roleFilter === role ? "users-metric active" : "users-metric"} onClick={() => setRoleFilter(role)}>
              <span>{t(`users_${role}`)}</span>
              <strong>{roleCounts[role]}</strong>
            </button>
          ))}
          {VALID_STATUS.map((status) => (
            <button key={status} type="button" className={statusFilter === status ? "users-metric active" : "users-metric"} onClick={() => setStatusFilter(status)}>
              <span>{t(`users_${status}`)}</span>
              <strong>{statusCounts[status]}</strong>
            </button>
          ))}
        </section>

        <section className="users-table-panel">
          <div className="users-toolbar">
            <div className="users-search">
              <Search size={16} />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("users_search_ph")}
                aria-label={t("users_search_ph")}
              />
            </div>
            <div className="users-filter-group" aria-label={t("users_filters")}>
              <SlidersHorizontal size={16} />
              <select className="form-input" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value as RoleFilter)}>
                <option value="all">{t("users_filter_all_roles")}</option>
                {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
              </select>
              <select className="form-input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">{t("users_filter_all_statuses")}</option>
                {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
              </select>
              {hasActiveFilters ? (
                <button type="button" className="btn btn-outline users-clear-btn" onClick={clearFilters}>
                  <X size={14} />
                  {t("users_clear_filters")}
                </button>
              ) : null}
            </div>
          </div>

          {isAdding ? (
            <div className="users-create-panel">
              <div className="users-create-copy">
                <strong>{t("users_create_panel_title")}</strong>
                <span>{t("users_create_panel_desc")}</span>
              </div>
              <div className="users-create-grid">
                <label>
                  <span>{t("users_username")}</span>
                  <input
                    type="text"
                    className="form-input"
                    value={newForm.username}
                    onChange={(event) => setNewForm((current) => ({ ...current, username: event.target.value }))}
                    autoFocus
                  />
                  {newFormError === t("users_err_username") ? <em>{newFormError}</em> : null}
                </label>
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
                <label>
                  <span>{t("users_password_new")}</span>
                  {renderPasswordInput(
                    newForm.password,
                    (password) => setNewForm((current) => ({ ...current, password })),
                    newPasswordVisible,
                    setNewPasswordVisible,
                    t("users_password_new"),
                  )}
                  {newFormError === t("users_err_password") ? <em>{newFormError}</em> : null}
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
                  {newFormError === t("users_err_password_match") ? <em>{newFormError}</em> : null}
                </label>
              </div>
              <div className="users-create-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setIsAdding(false); resetNewForm(); }} disabled={savingAction === "create"}>
                  <X size={15} />
                  {t("cancel")}
                </button>
                <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={savingAction === "create"}>
                  {savingAction === "create" ? <span className="spinner" /> : <Save size={15} />}
                  {t("save")}
                </button>
              </div>
            </div>
          ) : null}

          <div className="users-table-meta">
            <span>{t("users_count_filtered", { count: filteredUsers.length, total: users.length })}</span>
          </div>

          <div className="users-table-scroll">
            <table className="users-table">
              <thead>
                <tr>
                  <th><span><User size={15} /> {t("users_username")}</span></th>
                  <th><span><Shield size={15} /> {t("users_role")}</span></th>
                  <th><span><Activity size={15} /> {t("users_status")}</span></th>
                  <th><span><Clock size={15} /> {t("users_created")}</span></th>
                  <th><span><Settings size={15} /> {t("users_actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={5}>
                      <LoadingRows columns={5} rows={4} />
                    </td>
                  </tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState
                        icon={<User size={46} />}
                        title={t("users_empty")}
                        description={t("users_empty_desc")}
                        action={
                          <button type="button" className="btn btn-primary" onClick={() => setIsAdding(true)} disabled={isAdding}>
                            <Plus size={16} />
                            {t("users_new")}
                          </button>
                        }
                      />
                    </td>
                  </tr>
                ) : filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
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
                ) : filteredUsers.map((item) => {
                  const isSelf = item.username === currentUser?.username;
                  const isProtected = item.username === "admin" || isSelf;
                  return (
                    <tr key={item.username}>
                      <td>
                        <button type="button" className="users-identity-btn" onClick={() => openDetails(item)}>
                          <span className="users-avatar"><User size={16} /></span>
                          <span>
                            <strong>{item.username}</strong>
                            <small>{isSelf ? t("users_self") : item.createdBy || "--"}</small>
                          </span>
                        </button>
                      </td>
                      <td>{renderRoleBadge(item.role)}</td>
                      <td>{renderStatusBadge(item.status)}</td>
                      <td className="users-date-cell">{formatDateTime(item.createdAt)}</td>
                      <td>
                        <div className="users-row-actions">
                          <button type="button" className="btn-icon" onClick={() => openDetails(item)} title={t("users_open_detail")} aria-label={t("users_open_detail")}>
                            <Eye size={16} />
                          </button>
                          <button type="button" className="btn-icon" onClick={() => startEdit(item)} title={t("edit")} aria-label={t("edit")}>
                            <Settings size={16} />
                          </button>
                          {!isProtected ? (
                            <button
                              type="button"
                              className="btn-icon text-danger"
                              onClick={() => handleDelete(item.username)}
                              title={t("delete")}
                              aria-label={t("delete")}
                              disabled={savingAction === `delete:${item.username}` || pendingDeleteUsername != null}
                            >
                              <Trash2 size={16} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {notice ? (
        <OperationNotice
          presentation="modal"
          tone={notice.type === "success" ? "success" : "danger"}
          title={notice.type === "success" ? t("success") : t("error")}
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

      {selectedUser ? (
        <div className="users-drawer-layer" role="dialog" aria-modal="true" aria-label={t("users_drawer_title")}>
          <button type="button" className="users-drawer-backdrop" aria-label={t("cancel")} onClick={closeDrawer} />
          <aside className="users-drawer">
            <header className="users-drawer-header">
              <div>
                <span className="users-avatar large"><User size={20} /></span>
                <div>
                  <h2>{selectedUser.username}</h2>
                  <p>{t("users_drawer_subtitle")}</p>
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={closeDrawer} aria-label={t("cancel")} title={t("cancel")}>
                <X size={18} />
              </button>
            </header>

            <div className="users-drawer-body">
              <section className="users-detail-section">
                <h3>{t("users_detail_identity")}</h3>
                <dl>
                  <div>
                    <dt>{t("users_username")}</dt>
                    <dd>{selectedUser.username}</dd>
                  </div>
                  <div>
                    <dt>{t("users_role")}</dt>
                    <dd>{isEditingSelected ? (
                      <select className="form-input" value={editForm.role} onChange={(event) => setEditForm((current) => ({ ...current, role: event.target.value as RoleKey }))} disabled={selectedUser.username === "admin" || selectedUser.username === currentUser?.username}>
                        {VALID_ROLES.map((role) => <option key={role} value={role}>{t(`users_${role}`)}</option>)}
                      </select>
                    ) : renderRoleBadge(selectedUser.role)}</dd>
                  </div>
                  <div>
                    <dt>{t("users_status")}</dt>
                    <dd>{isEditingSelected ? (
                      <select className="form-input" value={editForm.status} onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as UserStatus }))} disabled={selectedUser.username === "admin" || selectedUser.username === currentUser?.username}>
                        {VALID_STATUS.map((status) => <option key={status} value={status}>{t(`users_${status}`)}</option>)}
                      </select>
                    ) : renderStatusBadge(selectedUser.status)}</dd>
                  </div>
                </dl>
              </section>

              <section className="users-detail-section">
                <h3>{t("users_detail_security")}</h3>
                <dl>
                  <div>
                    <dt>{t("users_detail_created_by")}</dt>
                    <dd>{selectedUser.createdBy || "--"}</dd>
                  </div>
                  <div>
                    <dt>{t("users_detail_created_at")}</dt>
                    <dd>{formatDateTime(selectedUser.createdAt)}</dd>
                  </div>
                  {isEditingSelected ? (
                    <div className="users-password-row">
                      <dt>{t("users_password_optional")}</dt>
                      <dd>
                        <input
                          type="password"
                          className="form-input"
                          value={editForm.password}
                          onChange={(event) => setEditForm((current) => ({ ...current, password: event.target.value }))}
                          placeholder={t("users_password_optional")}
                        />
                        {editFormError ? <em>{editFormError}</em> : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </section>
            </div>

            <footer className="users-drawer-footer">
              {isEditingSelected ? (
                <>
                  <button type="button" className="btn btn-outline" onClick={() => startEdit(selectedUser)} disabled={savingAction === `update:${selectedUser.username}`}>
                    <X size={15} />
                    {t("cancel")}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleUpdate} disabled={savingAction === `update:${selectedUser.username}`}>
                    {savingAction === `update:${selectedUser.username}` ? <span className="spinner" /> : <Save size={15} />}
                    {t("save")}
                  </button>
                </>
              ) : (
                <>
                  {selectedUser.username !== "admin" && selectedUser.username !== currentUser?.username ? (
                    <button type="button" className="btn btn-outline users-danger-action" onClick={() => handleDelete(selectedUser.username)} disabled={pendingDeleteUsername != null}>
                      <Trash2 size={15} />
                      {t("delete")}
                    </button>
                  ) : <span />}
                  <button type="button" className="btn btn-primary" onClick={() => startEdit(selectedUser)}>
                    <Settings size={15} />
                    {t("edit")}
                  </button>
                </>
              )}
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
    padding: 1.5rem;
    background: var(--background);
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
    margin-bottom: 1rem;
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
  .users-create-actions,
  .users-row-actions,
  .users-drawer-footer {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }

  .users-summary {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 0;
    overflow: hidden;
    margin-bottom: 1rem;
  }

  .users-metric {
    min-height: 78px;
    display: grid;
    gap: 0.28rem;
    align-content: center;
    padding: 0.8rem 1rem;
    border: 0;
    border-right: 1px solid var(--surface-border);
    background: transparent;
    color: var(--text-main);
    cursor: pointer;
    text-align: left;
    transition: background 0.18s ease, color 0.18s ease;
  }

  .users-metric:last-child {
    border-right: 0;
  }

  .users-metric:hover,
  .users-metric.active {
    background: color-mix(in srgb, var(--primary) 8%, transparent);
    color: var(--primary);
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
    min-height: 40px;
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

  .users-filter-group .form-input {
    width: auto;
    min-width: 138px;
    min-height: 40px;
    padding: 0.5rem 0.7rem;
    font-size: 0.86rem;
    border-radius: 7px;
  }

  .users-clear-btn {
    min-height: 40px;
    padding: 0.5rem 0.75rem;
  }

  .users-create-panel {
    display: grid;
    gap: 1rem;
    padding: 1rem;
    border-bottom: 1px solid var(--surface-border);
    background: color-mix(in srgb, var(--primary) 5%, var(--surface));
  }

  .users-create-copy {
    display: grid;
    gap: 0.25rem;
  }

  .users-create-copy strong {
    color: var(--text-main);
    font-size: 0.96rem;
  }

  .users-create-copy span,
  .users-table-meta {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .users-create-grid {
    display: grid;
    grid-template-columns: 1.1fr 0.75fr 1fr 1fr;
    gap: 0.75rem;
  }

  .users-create-grid label,
  .users-password-row dd {
    display: grid;
    gap: 0.35rem;
  }

  .users-create-grid label > span,
  .users-detail-section dt {
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .users-create-grid em,
  .users-password-row em {
    color: var(--danger);
    font-size: 0.74rem;
    font-style: normal;
  }

  .users-create-actions {
    justify-content: flex-end;
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

  .users-table-meta {
    padding: 0.75rem 1rem;
  }

  .users-table-scroll {
    overflow-x: auto;
  }

  .users-table {
    width: 100%;
    min-width: 860px;
    border-collapse: collapse;
    font-size: 0.92rem;
  }

  .users-table th,
  .users-table td {
    padding: 0.92rem 1rem;
    border-bottom: 1px solid var(--surface-border);
    text-align: left;
    vertical-align: middle;
  }

  .users-table th {
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: 0.74rem;
    font-weight: 800;
    text-transform: uppercase;
  }

  .users-table th:last-child,
  .users-table td:last-child {
    text-align: right;
  }

  .users-table th span {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .users-table tbody tr {
    transition: background 0.16s ease;
  }

  .users-table tbody tr:hover {
    background: var(--surface-hover);
  }

  .users-identity-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-main);
    cursor: pointer;
    text-align: left;
  }

  .users-identity-btn span:last-child {
    display: grid;
    gap: 0.16rem;
  }

  .users-identity-btn strong {
    font-size: 0.92rem;
    font-weight: 800;
  }

  .users-identity-btn small {
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
    flex-shrink: 0;
  }

  .users-avatar.large {
    width: 42px;
    height: 42px;
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

  .users-date-cell {
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .users-row-actions {
    justify-content: flex-end;
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
    width: min(460px, 100vw);
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

  .users-drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem;
    display: grid;
    align-content: start;
    gap: 1rem;
  }

  .users-detail-section {
    display: grid;
    gap: 0.85rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--surface-border);
  }

  .users-detail-section:last-child {
    border-bottom: 0;
  }

  .users-detail-section h3 {
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
    grid-template-columns: 120px minmax(0, 1fr);
    align-items: center;
    gap: 0.75rem;
  }

  .users-detail-section dd {
    min-width: 0;
    margin: 0;
    color: var(--text-main);
    overflow-wrap: anywhere;
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
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .users-create-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 860px) {
    .users-page {
      padding: 1rem;
    }

    .users-page-header,
    .users-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .users-header-actions {
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .users-search {
      min-width: 0;
    }

    .users-create-grid,
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
