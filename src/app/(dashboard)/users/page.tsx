"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Plus, Trash2, Shield, User, Clock, Settings, Save, X, Activity } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useI18n } from "@/components/I18nProvider";

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

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const VALID_ROLES = ["root", "operator", "viewer"];
const VALID_STATUS = ["active", "disabled"];

export default function UsersPage() {
  const { data, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const users = data?.users || [];
  const { user: currentUser, isRoot } = useAuth();
  const { t } = useI18n();

  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState({ username: "", password: "", role: "operator" });

  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ role: "", status: "", password: "" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);

  const format = (key: string, values: Record<string, string | number>) =>
    Object.entries(values).reduce((text, [token, value]) => text.replace(`{${token}}`, String(value)), t(key));

  const readError = async (res: Response, fallback: string) => {
    try {
      const body = await res.json();
      return body?.error || fallback;
    } catch {
      return fallback;
    }
  };

  const getCreateError = () => {
    if (!USERNAME_PATTERN.test(newForm.username.trim())) return t("users_err_username");
    if (newForm.password.length < 8) return t("users_err_password");
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
  const editFormError = editingUser ? getEditError() : "";

  if (!isRoot) {
    return (
      <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted)" }}>
        <Shield size={48} style={{ margin: "0 auto 1rem", opacity: 0.2 }} />
        <h2>{t("users_access_denied")}</h2>
        <p>{t("users_access_denied_desc")}</p>
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
        body: JSON.stringify({ ...newForm, username: newForm.username.trim() })
      });
      if (res.ok) {
        setIsAdding(false);
        setNewForm({ username: "", password: "", role: "operator" });
        setNotice({ type: "success", text: t("users_msg_created") });
        void mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_create")) });
      }
    } catch (e) {
      console.error(e);
      setNotice({ type: "error", text: t("users_err_create") });
    } finally {
      setSavingAction(null);
    }
  };

  const startEdit = (u: SysUser) => {
    setEditingUser(u.username);
    setEditForm({ role: u.role, status: u.status || "active", password: "" });
    setNotice(null);
  };

  const handleUpdate = async (username: string) => {
    const validationError = getEditError();
    if (validationError) {
      setNotice({ type: "error", text: validationError });
      return;
    }

    setSavingAction(`update:${username}`);
    try {
      const payload: { role?: string; status?: string; password?: string } = {};
      if (editForm.role) payload.role = editForm.role;
      if (editForm.status) payload.status = editForm.status;
      if (editForm.password) payload.password = editForm.password;

      const res = await fetch(`/api/auth/users/${username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setEditingUser(null);
        setNotice({ type: "success", text: t("users_msg_updated") });
        void mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_update")) });
      }
    } catch (e) {
      console.error(e);
      setNotice({ type: "error", text: t("users_err_update") });
    } finally {
      setSavingAction(null);
    }
  };

  const handleDelete = async (username: string) => {
    if (username === "admin" || username === currentUser?.username) {
      setNotice({ type: "error", text: t("users_err_protected") });
      return;
    }
    if (!confirm(format("users_delete_confirm", { username }))) return;

    setSavingAction(`delete:${username}`);
    try {
      const res = await fetch(`/api/auth/users/${username}`, { method: "DELETE" });
      if (res.ok) {
        setNotice({ type: "success", text: t("users_msg_deleted") });
        void mutate();
      } else {
        setNotice({ type: "error", text: await readError(res, t("users_err_delete")) });
      }
    } catch (e) {
      console.error(e);
      setNotice({ type: "error", text: t("users_err_delete") });
    } finally {
      setSavingAction(null);
    }
  };

  return (
    <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 600, color: "var(--text-main)" }}>{t("users_title")}</h1>
          <p style={{ margin: "0.5rem 0 0 0", color: "var(--text-muted)", fontSize: "0.95rem" }}>{t("users_subtitle")}</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setIsAdding(true);
            setNotice(null);
          }}
          style={{ padding: "0.6rem 1.25rem", display: "flex", alignItems: "center", gap: "0.5rem", borderRadius: "24px" }}
        >
          <Plus size={18} /> {t("users_new")}
        </button>
      </div>

      {notice && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.85rem 1rem",
            borderRadius: "10px",
            border: `1px solid ${notice.type === "success" ? "rgba(16, 185, 129, 0.24)" : "rgba(239, 68, 68, 0.24)"}`,
            background: notice.type === "success" ? "rgba(16, 185, 129, 0.08)" : "rgba(239, 68, 68, 0.08)",
            color: notice.type === "success" ? "var(--success)" : "var(--danger)",
            fontSize: "0.9rem",
            fontWeight: 600
          }}
        >
          {notice.text}
        </div>
      )}

      <div className="dash-card" style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.95rem" }}>
          <thead>
            <tr style={{ background: "var(--surface-hover)", borderBottom: "2px solid var(--surface-border)" }}>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><User size={16} /> {t("users_username")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Shield size={16} /> {t("users_role")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Activity size={16} /> {t("users_status")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Clock size={16} /> {t("users_created")}</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "right", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "flex-end" }}><Settings size={16} /> {t("users_actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {isAdding && (
              <tr style={{ background: "rgba(59, 130, 246, 0.08)", borderBottom: "1px solid var(--surface-border)" }}>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="text" className="form-input" style={{ width: "100%" }} placeholder={t("users_username")} value={newForm.username} onChange={e => setNewForm({ ...newForm, username: e.target.value })} autoFocus />
                  {newFormError === t("users_err_username") && <div style={{ marginTop: "0.35rem", color: "var(--danger)", fontSize: "0.75rem" }}>{newFormError}</div>}
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <select className="form-input" style={{ width: "100%" }} value={newForm.role} onChange={e => setNewForm({ ...newForm, role: e.target.value })}>
                    <option value="root">{t("users_root")}</option>
                    <option value="operator">{t("users_operator")}</option>
                    <option value="viewer">{t("users_viewer")}</option>
                  </select>
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="password" className="form-input" style={{ width: "100%" }} placeholder={t("users_password_new")} value={newForm.password} onChange={e => setNewForm({ ...newForm, password: e.target.value })} />
                  {newFormError === t("users_err_password") && <div style={{ marginTop: "0.35rem", color: "var(--danger)", fontSize: "0.75rem" }}>{newFormError}</div>}
                </td>
                <td style={{ padding: "1rem 1.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  {t("users_pending")}
                </td>
                <td style={{ padding: "1rem 1.5rem", textAlign: "right" }}>
                  <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                    <button className="btn-icon" onClick={handleCreate} title={t("save")} disabled={Boolean(newFormError) || savingAction === "create"}><Save size={18} color="var(--success)" /></button>
                    <button className="btn-icon" onClick={() => setIsAdding(false)} title={t("cancel")} disabled={savingAction === "create"}><X size={18} color="var(--text-muted)" /></button>
                  </div>
                </td>
              </tr>
            )}

            {isLoading ? (
              <tr><td colSpan={5} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t("users_loading")}</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t("users_empty")}</td></tr>
            ) : users.map(u => {
              const isSelf = u.username === currentUser?.username;
              const isLockedIdentity = isSelf || u.username === "admin";
              const status = u.status || "active";
              return (
                <tr key={u.username} style={{ borderBottom: "1px solid var(--surface-border)", transition: "background 0.15s" }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {editingUser === u.username ? (
                    <>
                      <td style={{ padding: "1rem 1.5rem", fontWeight: 600, color: "var(--text-main)" }}>
                        {u.username}
                      </td>
                      <td style={{ padding: "1rem 1.5rem" }}>
                        <select className="form-input" style={{ width: "100%" }} value={editForm.role} onChange={e => setEditForm({ ...editForm, role: e.target.value })} disabled={isLockedIdentity}>
                          <option value="root">{t("users_root")}</option>
                          <option value="operator">{t("users_operator")}</option>
                          <option value="viewer">{t("users_viewer")}</option>
                        </select>
                      </td>
                      <td style={{ padding: "1rem 1.5rem" }}>
                         <div style={{ display: "flex", gap: "0.5rem", flexDirection: "column" }}>
                           <select className="form-input" style={{ width: "100%" }} value={editForm.status} onChange={e => setEditForm({ ...editForm, status: e.target.value })} disabled={isLockedIdentity}>
                             <option value="active">{t("users_active")}</option>
                             <option value="disabled">{t("users_disabled")}</option>
                           </select>
                           <input type="password" placeholder={t("users_password_optional")} className="form-input" style={{ width: "100%", fontSize: "0.8rem" }} value={editForm.password} onChange={e => setEditForm({ ...editForm, password: e.target.value })} />
                           {editFormError && <div style={{ color: "var(--danger)", fontSize: "0.75rem" }}>{editFormError}</div>}
                         </div>
                      </td>
                      <td style={{ padding: "1rem 1.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "1rem 1.5rem", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                          <button className="btn-icon" onClick={() => handleUpdate(u.username)} title={t("save")} disabled={Boolean(editFormError) || savingAction === `update:${u.username}`}><Save size={18} color="var(--success)" /></button>
                          <button className="btn-icon" onClick={() => setEditingUser(null)} title={t("cancel")} disabled={savingAction === `update:${u.username}`}><X size={18} color="var(--text-muted)" /></button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ padding: "1.25rem 1.5rem", fontWeight: 600, color: "var(--text-main)" }}>
                        {u.username}
                        {isSelf && <span style={{ marginLeft: "0.5rem", background: "rgba(59, 130, 246, 0.12)", color: "var(--primary)", padding: "2px 6px", borderRadius: "10px", fontSize: "0.7rem", fontWeight: 600 }}>{t("users_self")}</span>}
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem" }}>
                        <span style={{
                          background: u.role === 'root' ? "rgba(239, 68, 68, 0.12)" : u.role === 'operator' ? "rgba(245, 158, 11, 0.12)" : "rgba(59, 130, 246, 0.12)",
                          color: u.role === 'root' ? "var(--danger)" : u.role === 'operator' ? "#d97706" : "var(--primary)",
                          padding: "3px 10px", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600, textTransform: "capitalize"
                        }}>
                          {t(`users_${u.role}`)}
                        </span>
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem" }}>
                        <span style={{
                          background: status === 'active' ? "rgba(16, 185, 129, 0.12)" : "rgba(100, 116, 139, 0.12)",
                          color: status === 'active' ? "var(--success)" : "var(--text-muted)",
                          padding: "3px 10px", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600, textTransform: "capitalize"
                        }}>
                          {t(`users_${status}`)}
                        </span>
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                        {new Date(u.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                          <button className="btn-icon" onClick={() => startEdit(u)} title={t("edit")}><Settings size={16} color="var(--primary)" /></button>
                          {u.username !== "admin" && !isSelf && (
                            <button className="btn-icon" onClick={() => handleDelete(u.username)} title={t("delete")} disabled={savingAction === `delete:${u.username}`}><Trash2 size={16} color="var(--danger)" /></button>
                          )}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
