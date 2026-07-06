"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Plus, Trash2, Shield, User, Clock, Settings, Save, X, Activity } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

interface SysUser {
  username: string;
  role: string;
  status: string;
  createdAt: string;
  createdBy: string;
}

export default function UsersPage() {
  const { data, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const users = data?.users || [];
  const { user: currentUser, isRoot } = useAuth();

  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState({ username: "", password: "", role: "operator" });

  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ role: "", status: "", password: "" });

  if (!isRoot) {
    return (
      <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted)" }}>
        <Shield size={48} style={{ margin: "0 auto 1rem", opacity: 0.2 }} />
        <h2>Access Denied</h2>
        <p>Root privileges are required to view this page.</p>
      </div>
    );
  }

  const handleCreate = async () => {
    if (!newForm.username || !newForm.password) return;
    try {
      const res = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm)
      });
      if (res.ok) {
        setIsAdding(false);
        setNewForm({ username: "", password: "", role: "operator" });
        mutate();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to create user");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const startEdit = (u: SysUser) => {
    setEditingUser(u.username);
    setEditForm({ role: u.role, status: u.status || "active", password: "" });
  };

  const handleUpdate = async (username: string) => {
    try {
      const payload: any = {};
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
        mutate();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to update user");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async (username: string) => {
    if (username === "admin" || username === currentUser?.username) {
      alert("Cannot delete admin or yourself.");
      return;
    }
    if (!confirm(`Are you sure you want to delete user ${username}?`)) return;

    try {
      const res = await fetch(`/api/auth/users/${username}`, { method: "DELETE" });
      if (res.ok) {
        mutate();
      } else {
        const err = await res.json();
        alert(err.error || "Failed to delete user");
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 600, color: "var(--text-main)" }}>System Users</h1>
          <p style={{ margin: "0.5rem 0 0 0", color: "var(--text-muted)", fontSize: "0.95rem" }}>Manage operator and viewer accounts</p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setIsAdding(true)}
          style={{ padding: "0.6rem 1.25rem", display: "flex", alignItems: "center", gap: "0.5rem", borderRadius: "24px" }}
        >
          <Plus size={18} /> New User
        </button>
      </div>

      <div className="dash-card" style={{ overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.95rem" }}>
          <thead>
            <tr style={{ background: "var(--surface-hover)", borderBottom: "2px solid var(--surface-border)" }}>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><User size={16} /> Username</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Shield size={16} /> Role</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Activity size={16} /> Status</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "left", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}><Clock size={16} /> Created</span>
              </th>
              <th className="table-header-cap" style={{ padding: "1.25rem 1.5rem", textAlign: "right", width: "20%" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "flex-end" }}><Settings size={16} /> Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {isAdding && (
              <tr style={{ background: "rgba(59, 130, 246, 0.08)", borderBottom: "1px solid var(--surface-border)" }}>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="text" className="form-input" style={{ width: "100%" }} placeholder="Username" value={newForm.username} onChange={e => setNewForm({...newForm, username: e.target.value})} autoFocus />
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <select className="form-input" style={{ width: "100%" }} value={newForm.role} onChange={e => setNewForm({...newForm, role: e.target.value})}>
                    <option value="root">Root</option>
                    <option value="operator">Operator</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </td>
                <td style={{ padding: "1rem 1.5rem" }}>
                  <input type="password" className="form-input" style={{ width: "100%" }} placeholder="Password" value={newForm.password} onChange={e => setNewForm({...newForm, password: e.target.value})} />
                </td>
                <td style={{ padding: "1rem 1.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                  Pending
                </td>
                <td style={{ padding: "1rem 1.5rem", textAlign: "right" }}>
                  <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                    <button className="btn-icon" onClick={handleCreate} title="Save"><Save size={18} color="var(--success)" /></button>
                    <button className="btn-icon" onClick={() => setIsAdding(false)} title="Cancel"><X size={18} color="var(--text-muted)" /></button>
                  </div>
                </td>
              </tr>
            )}

            {isLoading ? (
              <tr><td colSpan={5} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>Loading users...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>No users found</td></tr>
            ) : users.map(u => {
              const isSelf = u.username === currentUser?.username;
              return (
                <tr key={u.username} style={{ borderBottom: "1px solid var(--surface-border)", transition: "background 0.15s" }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-hover)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {editingUser === u.username ? (
                    <>
                      <td style={{ padding: "1rem 1.5rem", fontWeight: 600, color: "var(--text-main)" }}>
                        {u.username}
                      </td>
                      <td style={{ padding: "1rem 1.5rem" }}>
                        <select className="form-input" style={{ width: "100%" }} value={editForm.role} onChange={e => setEditForm({...editForm, role: e.target.value})} disabled={isSelf || u.username === 'admin'}>
                          <option value="root">Root</option>
                          <option value="operator">Operator</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      </td>
                      <td style={{ padding: "1rem 1.5rem" }}>
                         <div style={{ display: "flex", gap: "0.5rem", flexDirection: "column" }}>
                           <select className="form-input" style={{ width: "100%" }} value={editForm.status} onChange={e => setEditForm({...editForm, status: e.target.value})} disabled={isSelf || u.username === 'admin'}>
                             <option value="active">Active</option>
                             <option value="disabled">Disabled</option>
                           </select>
                           <input type="password" placeholder="New Pwd (optional)" className="form-input" style={{ width: "100%", fontSize: "0.8rem" }} value={editForm.password} onChange={e => setEditForm({...editForm, password: e.target.value})} />
                         </div>
                      </td>
                      <td style={{ padding: "1rem 1.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "1rem 1.5rem", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                          <button className="btn-icon" onClick={() => handleUpdate(u.username)} title="Save"><Save size={18} color="var(--success)" /></button>
                          <button className="btn-icon" onClick={() => setEditingUser(null)} title="Cancel"><X size={18} color="var(--text-muted)" /></button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ padding: "1.25rem 1.5rem", fontWeight: 600, color: "var(--text-main)" }}>
                        {u.username}
                        {isSelf && <span style={{ marginLeft: "0.5rem", background: "rgba(59, 130, 246, 0.12)", color: "var(--primary)", padding: "2px 6px", borderRadius: "10px", fontSize: "0.7rem", fontWeight: 600 }}>You</span>}
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem" }}>
                        <span style={{
                          background: u.role === 'root' ? "rgba(239, 68, 68, 0.12)" : u.role === 'operator' ? "rgba(245, 158, 11, 0.12)" : "rgba(59, 130, 246, 0.12)",
                          color: u.role === 'root' ? "var(--danger)" : u.role === 'operator' ? "#d97706" : "var(--primary)",
                          padding: "3px 10px", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600, textTransform: "capitalize"
                        }}>
                          {u.role}
                        </span>
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem" }}>
                        <span style={{
                          background: u.status === 'active' ? "rgba(16, 185, 129, 0.12)" : "rgba(100, 116, 139, 0.12)",
                          color: u.status === 'active' ? "var(--success)" : "var(--text-muted)",
                          padding: "3px 10px", borderRadius: "12px", fontSize: "0.85rem", fontWeight: 600, textTransform: "capitalize"
                        }}>
                          {u.status || "active"}
                        </span>
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                        {new Date(u.createdAt).toLocaleString()}
                      </td>
                      <td style={{ padding: "1.25rem 1.5rem", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                          <button className="btn-icon" onClick={() => startEdit(u)} title="Edit"><Settings size={16} color="var(--primary)" /></button>
                          {u.username !== "admin" && !isSelf && (
                            <button className="btn-icon" onClick={() => handleDelete(u.username)} title="Delete"><Trash2 size={16} color="var(--danger)" /></button>
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
