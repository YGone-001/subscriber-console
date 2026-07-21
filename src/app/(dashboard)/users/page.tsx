"use client";

import { useMemo, useState } from "react";
import type React from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Plus, Trash2, Shield, User, Clock, Settings, Save, X, Activity, CheckCircle2, Eye, LockKeyhole, SlidersHorizontal, Download, RotateCcw, GitBranch, RefreshCw, Search, FileJson, MessageSquare, AlertTriangle, History, Braces, ChevronRight } from "lucide-react";
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
type PermissionLevel = "manage" | "write" | "read" | "none";
type CapabilityLevel = "allow" | "approval" | "export" | "deny";
type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";
type ApprovalAction = "POLICY_CHANGE" | "TRAFFIC_ADJUSTMENT" | "RATING_CREATE" | "RATING_UPDATE" | "RATING_DELETE" | "PROFILE_RESTORE" | "SYSTEM_HEAL" | "SUBSCRIBER_BATCH_CREATE" | "SUBSCRIBER_IMPORT" | "SUBSCRIBER_BULK_DELETE";

type ApprovalRequest = {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  requester: string;
  reviewer?: string;
  targetId: string;
  summary: string;
  createdAt: string;
  reviewedAt?: string;
  executedAt?: string;
  payload?: Record<string, unknown>;
  note?: string;
  result?: unknown;
  error?: string;
};

type ApprovalSlaTone = "ok" | "warning" | "danger";

type ApprovalSlaSummary = Record<ApprovalSlaTone, number> & {
  oldestHours: number;
};

type AuditLog = {
  id: string;
  timestamp: string;
  level: "info" | "warning";
  action: string;
  targetId: string;
  operatorIp: string;
  oldData: unknown;
  newData: unknown;
};

type ApprovalAuditTrail = {
  logs: AuditLog[];
  summary: {
    total: number;
    lifecycle: number;
    execution: number;
  };
};

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
const VALID_ROLES: string[] = ["root", "operator", "viewer"];
const VALID_STATUS = ["active", "disabled"];

const ROLE_STYLE: Record<RoleKey, { color: string; bg: string; border: string }> = {
  root: { color: "var(--danger)", bg: "rgba(239, 68, 68, 0.1)", border: "rgba(239, 68, 68, 0.28)" },
  operator: { color: "#d97706", bg: "rgba(245, 158, 11, 0.1)", border: "rgba(245, 158, 11, 0.28)" },
  viewer: { color: "var(--primary)", bg: "rgba(59, 130, 246, 0.1)", border: "rgba(59, 130, 246, 0.28)" },
};

const PERMISSION_STYLE: Record<PermissionLevel, { color: string; bg: string; icon: React.ReactNode }> = {
  manage: { color: "var(--danger)", bg: "rgba(239, 68, 68, 0.1)", icon: <LockKeyhole size={14} /> },
  write: { color: "var(--success)", bg: "rgba(16, 185, 129, 0.1)", icon: <CheckCircle2 size={14} /> },
  read: { color: "var(--primary)", bg: "rgba(59, 130, 246, 0.1)", icon: <Eye size={14} /> },
  none: { color: "var(--text-muted)", bg: "var(--surface-hover)", icon: <X size={14} /> },
};

const CAPABILITY_STYLE: Record<CapabilityLevel, { color: string; bg: string; icon: React.ReactNode }> = {
  allow: { color: "var(--success)", bg: "rgba(16, 185, 129, 0.1)", icon: <CheckCircle2 size={14} /> },
  approval: { color: "#d97706", bg: "rgba(245, 158, 11, 0.12)", icon: <GitBranch size={14} /> },
  export: { color: "var(--primary)", bg: "rgba(59, 130, 246, 0.1)", icon: <Download size={14} /> },
  deny: { color: "var(--text-muted)", bg: "var(--surface-hover)", icon: <X size={14} /> },
};

const APPROVAL_STATUS_STYLE: Record<ApprovalStatus, { color: string; bg: string }> = {
  pending: { color: "#d97706", bg: "rgba(245, 158, 11, 0.12)" },
  approved: { color: "var(--primary)", bg: "rgba(59, 130, 246, 0.1)" },
  rejected: { color: "var(--danger)", bg: "rgba(239, 68, 68, 0.1)" },
  executed: { color: "var(--success)", bg: "rgba(16, 185, 129, 0.1)" },
  failed: { color: "var(--danger)", bg: "rgba(239, 68, 68, 0.1)" },
};

const APPROVAL_SLA_STYLE: Record<ApprovalSlaTone, { color: string; bg: string }> = {
  ok: { color: "var(--success)", bg: "rgba(16, 185, 129, 0.1)" },
  warning: { color: "#d97706", bg: "rgba(245, 158, 11, 0.12)" },
  danger: { color: "var(--danger)", bg: "rgba(239, 68, 68, 0.1)" },
};

const APPROVAL_FILTERS: Array<ApprovalStatus | "all"> = ["pending", "failed", "executed", "approved", "rejected", "all"];

const DEFAULT_APPROVAL_SLA: ApprovalSlaSummary = { ok: 0, warning: 0, danger: 0, oldestHours: 0 };

function getApprovalAgeHours(createdAt: string) {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 3600000));
}

function getApprovalSlaTone(createdAt: string): ApprovalSlaTone {
  const hours = getApprovalAgeHours(createdAt);
  if (hours >= 48) return "danger";
  if (hours >= 24) return "warning";
  return "ok";
}

const PERMISSION_MODULES: Array<{
  key: string;
  root: PermissionLevel;
  operator: PermissionLevel;
  viewer: PermissionLevel;
}> = [
  { key: "subscribers", root: "write", operator: "write", viewer: "read" },
  { key: "profiles", root: "manage", operator: "read", viewer: "read" },
  { key: "rating", root: "manage", operator: "read", viewer: "read" },
  { key: "audit", root: "read", operator: "read", viewer: "read" },
  { key: "health", root: "manage", operator: "read", viewer: "read" },
  { key: "users", root: "manage", operator: "none", viewer: "none" },
];

const ACTION_CAPABILITIES: Array<{
  key: string;
  icon: React.ReactNode;
  root: CapabilityLevel;
  operator: CapabilityLevel;
  viewer: CapabilityLevel;
}> = [
  { key: "subscriber_write", icon: <User size={16} />, root: "allow", operator: "allow", viewer: "deny" },
  { key: "policy_approve", icon: <GitBranch size={16} />, root: "allow", operator: "approval", viewer: "deny" },
  { key: "balance_adjust", icon: <SlidersHorizontal size={16} />, root: "allow", operator: "approval", viewer: "deny" },
  { key: "profile_rollback", icon: <RotateCcw size={16} />, root: "allow", operator: "approval", viewer: "deny" },
  { key: "rating_publish", icon: <CheckCircle2 size={16} />, root: "allow", operator: "approval", viewer: "deny" },
  { key: "audit_export", icon: <Download size={16} />, root: "export", operator: "export", viewer: "export" },
  { key: "system_heal", icon: <Activity size={16} />, root: "allow", operator: "approval", viewer: "deny" },
  { key: "user_admin", icon: <Shield size={16} />, root: "allow", operator: "deny", viewer: "deny" },
];

export default function UsersPage() {
  const { user: currentUser, isRoot } = useAuth();
  const { t } = useI18n();
  const { data, isLoading, mutate } = useSWR<{ users: SysUser[] }>("/api/auth/users", fetcher);
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<ApprovalStatus | "all">("pending");
  const [approvalSlaFilter, setApprovalSlaFilter] = useState<ApprovalSlaTone | "all">("all");
  const [approvalSearchQuery, setApprovalSearchQuery] = useState("");
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState("");
  const [selectedAuditLog, setSelectedAuditLog] = useState<AuditLog | null>(null);
  const [approvalExportFormat, setApprovalExportFormat] = useState<"json" | "csv">("json");
  const [approvalExportRequester, setApprovalExportRequester] = useState("");
  const [approvalExportFrom, setApprovalExportFrom] = useState("");
  const [approvalExportTo, setApprovalExportTo] = useState("");
  const [exportingApprovalScope, setExportingApprovalScope] = useState<string | null>(null);
  const { data: approvalData, isLoading: isApprovalLoading, mutate: mutateApprovals } = useSWR<{ approvals: ApprovalRequest[]; pending: number; sla?: ApprovalSlaSummary }>(
    isRoot ? `/api/approvals?limit=30&status=${approvalStatusFilter}` : null,
    fetcher,
    { refreshInterval: 30000 }
  );
  const { data: approvalAuditData, isLoading: isApprovalAuditLoading } = useSWR<ApprovalAuditTrail>(
    isRoot && selectedApprovalId ? `/api/approvals/${selectedApprovalId}/audit` : null,
    fetcher,
    { refreshInterval: 30000 }
  );
  const users = data?.users || [];
  const approvals = useMemo(() => approvalData?.approvals || [], [approvalData?.approvals]);
  const approvalAuditLogs = useMemo(() => approvalAuditData?.logs || [], [approvalAuditData?.logs]);

  const [isAdding, setIsAdding] = useState(false);
  const [newForm, setNewForm] = useState({ username: "", password: "", role: "operator" });

  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ role: "", status: "", password: "" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [pendingDeleteUsername, setPendingDeleteUsername] = useState<string | null>(null);
  const [reviewingApprovalId, setReviewingApprovalId] = useState<string | null>(null);

  const filteredApprovals = useMemo(() => {
    const keyword = approvalSearchQuery.trim().toLowerCase();
    return approvals.filter((approval) => {
      if (approvalSlaFilter !== "all" && (approval.status !== "pending" || getApprovalSlaTone(approval.createdAt) !== approvalSlaFilter)) {
        return false;
      }
      if (!keyword) return true;
      const haystack = [
        approval.id,
        approval.action,
        approval.targetId,
        approval.requester,
        approval.reviewer || "",
        approval.summary,
        approval.status,
      ].join(" ").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [approvalSearchQuery, approvalSlaFilter, approvals]);

  const selectedApproval = selectedApprovalId
    ? filteredApprovals.find((approval) => approval.id === selectedApprovalId) || null
    : null;

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
  const roleCounts = VALID_ROLES.reduce<Record<RoleKey, number>>((acc, role) => {
    acc[role as RoleKey] = users.filter((item) => item.role === role).length;
    return acc;
  }, { root: 0, operator: 0, viewer: 0 });

  const approvalPendingCount = approvalData?.pending || approvals.filter((item) => item.status === "pending").length;
  const approvalSla = approvalData?.sla || approvals.reduce<ApprovalSlaSummary>((acc, approval) => {
    if (approval.status !== "pending") return acc;
    const hours = getApprovalAgeHours(approval.createdAt);
    acc[getApprovalSlaTone(approval.createdAt)] += 1;
    acc.oldestHours = Math.max(acc.oldestHours, hours);
    return acc;
  }, { ...DEFAULT_APPROVAL_SLA });

  const renderPermissionBadge = (level: PermissionLevel) => {
    const style = PERMISSION_STYLE[level];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.35rem",
          minWidth: 86,
          padding: "0.35rem 0.55rem",
          borderRadius: "999px",
          background: style.bg,
          color: style.color,
          fontSize: "0.78rem",
          fontWeight: 800,
        }}
      >
        {style.icon}
        {t(`users_perm_${level}`)}
      </span>
    );
  };

  const renderCapabilityBadge = (level: CapabilityLevel) => {
    const style = CAPABILITY_STYLE[level];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.35rem",
          width: "100%",
          minWidth: 0,
          padding: "0.35rem 0.55rem",
          borderRadius: "999px",
          background: style.bg,
          color: style.color,
          fontSize: "0.74rem",
          fontWeight: 800,
          whiteSpace: "nowrap",
        }}
      >
        {style.icon}
        {t(`users_cap_${level}`)}
      </span>
    );
  };

  const renderApprovalStatus = (status: ApprovalStatus) => {
    const style = APPROVAL_STATUS_STYLE[status] || APPROVAL_STATUS_STYLE.pending;
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 82,
          padding: "0.3rem 0.55rem",
          borderRadius: "999px",
          background: style.bg,
          color: style.color,
          fontSize: "0.74rem",
          fontWeight: 800,
        }}
      >
        {t(`approval_status_${status}`)}
      </span>
    );
  };

  const getApprovalIcon = (action: ApprovalAction) => {
    if (action.startsWith("SUBSCRIBER")) return <User size={15} color="var(--primary)" />;
    if (action.startsWith("RATING")) return <CheckCircle2 size={15} color="var(--primary)" />;
    if (action === "PROFILE_RESTORE") return <RotateCcw size={15} color="var(--primary)" />;
    if (action === "SYSTEM_HEAL") return <Activity size={15} color="var(--primary)" />;
    if (action === "POLICY_CHANGE") return <GitBranch size={15} color="var(--primary)" />;
    return <SlidersHorizontal size={15} color="var(--primary)" />;
  };

  const renderApprovalSla = (approval: ApprovalRequest) => {
    const hours = getApprovalAgeHours(approval.createdAt);
    const tone = getApprovalSlaTone(approval.createdAt);
    const style = APPROVAL_SLA_STYLE[tone];
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.35rem",
          minWidth: 94,
          padding: "0.3rem 0.55rem",
          borderRadius: "999px",
          background: style.bg,
          color: style.color,
          fontSize: "0.74rem",
          fontWeight: 800,
        }}
      >
        {tone === "danger" ? <AlertTriangle size={13} /> : <Clock size={13} />}
        {t(`approval_sla_${tone}`, { hours })}
      </span>
    );
  };

  const formatApprovalValue = (value: unknown) => {
    if (value === undefined || value === null || value === "") return "--";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const formatAuditActionLabel = (action: string) => {
    const key = `audit_action_${action}`;
    const label = t(key);
    return label !== key ? label : action;
  };

  const isApprovalLifecycleLog = (log: AuditLog, approvalId: string) => log.targetId === `approval:${approvalId}`;

  const renderAuditStepLabel = (log: AuditLog, approvalId: string) => {
    if (isApprovalLifecycleLog(log, approvalId)) return t("approval_audit_step_lifecycle");
    return t("approval_audit_step_execution");
  };

  if (!isRoot) {
    return (
      <div className="container animate-fade-in" style={{ padding: "3rem" }}>
        <div className="dash-card" style={{ padding: 0, overflow: "hidden" }}>
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
        setNotice({ type: "success", text: t("users_msg_deleted") });
        await mutate();
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

  const handleApprovalDecision = async (approval: ApprovalRequest, decision: "approve" | "reject") => {
    setReviewingApprovalId(`${decision}:${approval.id}`);
    setNotice(null);
    try {
      const note = selectedApprovalId === approval.id ? approvalNote.trim() : "";
      const res = await fetch(`/api/approvals/${approval.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || undefined }),
      });

      if (res.ok) {
        setNotice({
          type: "success",
          text: decision === "approve" ? t("approval_msg_approved") : t("approval_msg_rejected"),
        });
        setApprovalNote("");
        setSelectedApprovalId(null);
        await mutateApprovals();
      } else {
        setNotice({ type: "error", text: await readError(res, t("approval_err_review")) });
        await mutateApprovals();
      }
    } catch (e) {
      console.error(e);
      setNotice({ type: "error", text: t("approval_err_review") });
    } finally {
      setReviewingApprovalId(null);
    }
  };

  const handleApprovalExport = async (approvalId?: string) => {
    const scope = approvalId ? `approval:${approvalId}` : "queue";
    setExportingApprovalScope(scope);
    setNotice(null);
    try {
      const params = new URLSearchParams({
        format: approvalExportFormat,
        limit: "500",
      });
      if (approvalId) {
        params.set("approvalId", approvalId);
      } else {
        params.set("status", approvalStatusFilter);
        if (approvalExportRequester.trim()) params.set("requester", approvalExportRequester.trim());
        if (approvalExportFrom) params.set("from", approvalExportFrom);
        if (approvalExportTo) params.set("to", approvalExportTo);
      }

      const res = await fetch(`/api/approvals/export?${params.toString()}`);
      if (!res.ok) {
        setNotice({ type: "error", text: await readError(res, t("approval_export_err")) });
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const filenameMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = filenameMatch?.[1] || `xcloud_approvals_${new Date().toISOString().slice(0, 10)}.${approvalExportFormat}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setNotice({ type: "success", text: t("approval_export_msg_ready") });
    } catch (e) {
      console.error(e);
      setNotice({ type: "error", text: t("approval_export_err") });
    } finally {
      setExportingApprovalScope(null);
    }
  };

  return (
    <>
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
        <OperationNotice
          presentation="modal"
          tone={notice.type === "success" ? "success" : "danger"}
          title={notice.type === "success" ? t("success") : t("error")}
          message={notice.text}
          onClose={() => setNotice(null)}
        />
      )}

      {pendingDeleteUsername && (
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
      )}

      <section
        className="dash-card"
        style={{
          padding: "1.25rem",
          marginBottom: "1.5rem",
          display: "grid",
          gap: "1.25rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.1rem", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.55rem" }}>
              <SlidersHorizontal size={18} color="var(--primary)" />
              {t("users_perm_title")}
            </h2>
            <p style={{ margin: "0.35rem 0 0", color: "var(--text-muted)", fontSize: "0.88rem" }}>
              {t("users_perm_subtitle")}
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            {(VALID_ROLES as RoleKey[]).map((role) => {
              const style = ROLE_STYLE[role];
              return (
                <span
                  key={role}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.45rem",
                    padding: "0.45rem 0.65rem",
                    borderRadius: "999px",
                    border: `1px solid ${style.border}`,
                    background: style.bg,
                    color: style.color,
                    fontSize: "0.82rem",
                    fontWeight: 800,
                  }}
                >
                  {t(`users_${role}`)}
                  <strong style={{ color: "var(--text-main)" }}>{roleCounts[role]}</strong>
                </span>
              );
            })}
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--surface-border)" }}>
                <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("users_perm_module")}</th>
                {(VALID_ROLES as RoleKey[]).map((role) => (
                  <th key={role} className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "center" }}>
                    {t(`users_${role}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_MODULES.map((module) => (
                <tr key={module.key} style={{ borderBottom: "1px solid var(--surface-border)" }}>
                  <td style={{ padding: "0.9rem 1rem", color: "var(--text-main)", fontWeight: 800 }}>
                    {t(`users_perm_module_${module.key}`)}
                    <div style={{ marginTop: "0.25rem", color: "var(--text-muted)", fontSize: "0.78rem", fontWeight: 500 }}>
                      {t(`users_perm_module_${module.key}_desc`)}
                    </div>
                  </td>
                  {(VALID_ROLES as RoleKey[]).map((role) => (
                    <td key={role} style={{ padding: "0.9rem 1rem", textAlign: "center" }}>
                      {renderPermissionBadge(module[role])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ borderTop: "1px solid var(--surface-border)", paddingTop: "1rem", display: "grid", gap: "0.85rem" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <div>
              <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "0.98rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <LockKeyhole size={16} color="var(--primary)" />
                {t("users_cap_title")}
              </h3>
              <p style={{ margin: "0.3rem 0 0", color: "var(--text-muted)", fontSize: "0.82rem" }}>
                {t("users_cap_subtitle")}
              </p>
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", minHeight: 30, padding: "0.35rem 0.65rem", borderRadius: "999px", background: "var(--surface-hover)", color: "var(--text-secondary)", fontSize: "0.78rem", fontWeight: 800 }}>
              <GitBranch size={14} />
              {t("users_cap_approval_hint")}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0.75rem" }}>
            {ACTION_CAPABILITIES.map((capability) => (
              <article
                key={capability.key}
                style={{
                  minHeight: 142,
                  border: "1px solid var(--surface-border)",
                  borderRadius: "8px",
                  padding: "0.9rem",
                  background: "var(--header-bg)",
                  display: "grid",
                  gap: "0.75rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "0.65rem" }}>
                  <div style={{ width: 34, height: 34, borderRadius: "8px", display: "grid", placeItems: "center", background: "var(--surface-hover)", color: "var(--primary)", flex: "0 0 auto" }}>
                    {capability.icon}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", color: "var(--text-main)", fontSize: "0.9rem", lineHeight: 1.25 }}>
                      {t(`users_cap_action_${capability.key}`)}
                    </strong>
                    <span style={{ display: "block", marginTop: "0.25rem", color: "var(--text-muted)", fontSize: "0.76rem", lineHeight: 1.35 }}>
                      {t(`users_cap_action_${capability.key}_desc`)}
                    </span>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.45rem" }}>
                  {(VALID_ROLES as RoleKey[]).map((role) => (
                    <div key={role} style={{ display: "grid", gap: "0.35rem", justifyItems: "center", minWidth: 0 }}>
                      <span style={{ color: "var(--text-muted)", fontSize: "0.68rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0 }}>
                        {t(`users_${role}`)}
                      </span>
                      {renderCapabilityBadge(capability[role])}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        className="dash-card"
        style={{
          padding: "1.25rem",
          marginBottom: "1.5rem",
          display: "grid",
          gap: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.1rem", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.55rem" }}>
              <GitBranch size={18} color="var(--primary)" />
              {t("approval_center_title")}
            </h2>
            <p style={{ margin: "0.35rem 0 0", color: "var(--text-muted)", fontSize: "0.88rem" }}>
              {t("approval_center_subtitle")}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.45rem", padding: "0.45rem 0.65rem", borderRadius: "999px", background: "rgba(245, 158, 11, 0.12)", color: "#d97706", fontSize: "0.82rem", fontWeight: 800 }}>
              <Clock size={14} />
              {t("approval_pending_count", { count: approvalPendingCount })}
            </span>
            <button type="button" className="btn btn-outline" onClick={() => mutateApprovals()} style={{ minHeight: 34, padding: "0.4rem 0.65rem" }}>
              <RefreshCw size={14} /> {t("audit_refresh")}
            </button>
          </div>
        </div>

        <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", background: "var(--header-bg)", padding: "0.85rem", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr)) auto", gap: "0.75rem", alignItems: "end" }}>
          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", fontWeight: 800 }}>{t("approval_export_requester")}</span>
            <input className="form-input" value={approvalExportRequester} onChange={(event) => setApprovalExportRequester(event.target.value)} placeholder={t("approval_export_requester_ph")} style={{ minHeight: 36 }} />
          </label>
          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", fontWeight: 800 }}>{t("approval_export_from")}</span>
            <input type="date" className="form-input" value={approvalExportFrom} onChange={(event) => setApprovalExportFrom(event.target.value)} style={{ minHeight: 36 }} />
          </label>
          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", fontWeight: 800 }}>{t("approval_export_to")}</span>
            <input type="date" className="form-input" value={approvalExportTo} onChange={(event) => setApprovalExportTo(event.target.value)} style={{ minHeight: 36 }} />
          </label>
          <label style={{ display: "grid", gap: "0.35rem" }}>
            <span style={{ color: "var(--text-muted)", fontSize: "0.72rem", fontWeight: 800 }}>{t("approval_export_format")}</span>
            <select className="form-input" value={approvalExportFormat} onChange={(event) => setApprovalExportFormat(event.target.value as "json" | "csv")} style={{ minHeight: 36 }}>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <button className="btn btn-outline" onClick={() => handleApprovalExport()} disabled={Boolean(exportingApprovalScope)} style={{ minHeight: 36, padding: "0.45rem 0.75rem", alignSelf: "end" }}>
            {exportingApprovalScope === "queue" ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <Download size={14} />}
            {t("approval_export_queue")}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.75rem" }}>
          {(["ok", "warning", "danger"] as ApprovalSlaTone[]).map((tone) => {
            const style = APPROVAL_SLA_STYLE[tone];
            const isActive = approvalSlaFilter === tone;
            return (
              <button
                key={tone}
                type="button"
                onClick={() => {
                  setApprovalStatusFilter("pending");
                  setApprovalSlaFilter(isActive ? "all" : tone);
                  setSelectedApprovalId(null);
                  setApprovalNote("");
                }}
                style={{
                  minHeight: 86,
                  border: `1px solid ${isActive ? style.color : "var(--surface-border)"}`,
                  borderRadius: "8px",
                  background: isActive ? style.bg : "var(--header-bg)",
                  padding: "0.85rem",
                  display: "grid",
                  gap: "0.45rem",
                  textAlign: "left",
                  cursor: "pointer",
                  boxShadow: isActive ? `0 0 0 3px ${style.bg}` : "none",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                  <strong style={{ color: "var(--text-main)", fontSize: "0.86rem" }}>{t(`approval_sla_bucket_${tone}`)}</strong>
                  <span style={{ color: style.color, fontSize: "1.25rem", fontWeight: 900 }}>{approvalSla[tone]}</span>
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: "0.76rem", lineHeight: 1.35 }}>
                  {t(`approval_sla_bucket_${tone}_desc`)}
                </span>
              </button>
            );
          })}
          <div style={{ minHeight: 86, border: "1px solid var(--surface-border)", borderRadius: "8px", background: "var(--header-bg)", padding: "0.85rem", display: "grid", gap: "0.45rem" }}>
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
              <strong style={{ color: "var(--text-main)", fontSize: "0.86rem" }}>{t("approval_sla_oldest")}</strong>
              <span style={{ color: approvalSla.danger > 0 ? "var(--danger)" : "var(--text-main)", fontSize: "1.25rem", fontWeight: 900 }}>{approvalSla.oldestHours}h</span>
            </span>
            <span style={{ color: "var(--text-muted)", fontSize: "0.76rem", lineHeight: 1.35 }}>
              {approvalSlaFilter === "all" ? t("approval_sla_queue_all") : t("approval_sla_queue_filtered", { bucket: t(`approval_sla_bucket_${approvalSlaFilter}`) })}
            </span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "0.75rem", alignItems: "center" }}>
          <label style={{ position: "relative", minWidth: 0 }}>
            <Search size={16} color="var(--text-muted)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
            <input
              className="form-input"
              value={approvalSearchQuery}
              onChange={(event) => setApprovalSearchQuery(event.target.value)}
              placeholder={t("approval_search_ph")}
              style={{ width: "100%", paddingLeft: 38, minHeight: 38 }}
            />
          </label>
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {APPROVAL_FILTERS.map((status) => {
              const isActive = approvalStatusFilter === status;
              return (
                <button
                  key={status}
                  type="button"
                  className={isActive ? "btn btn-primary" : "btn btn-outline"}
                  onClick={() => {
                    setApprovalStatusFilter(status);
                    setApprovalSlaFilter("all");
                    setSelectedApprovalId(null);
                    setApprovalNote("");
                  }}
                  style={{ minHeight: 34, padding: "0.4rem 0.65rem" }}
                >
                  {t(`approval_filter_${status}`)}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "1rem", alignItems: "start" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 900, borderCollapse: "collapse", fontSize: "0.88rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--surface-border)" }}>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("approval_col_action")}</th>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("approval_col_target")}</th>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("approval_col_requester")}</th>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("approval_col_status")}</th>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("approval_col_sla")}</th>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "left" }}>{t("approval_col_created")}</th>
                  <th className="table-header-cap" style={{ padding: "0.85rem 1rem", textAlign: "right" }}>{t("users_actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isApprovalLoading ? (
                  <tr>
                    <td colSpan={7}>
                      <LoadingRows columns={7} rows={3} />
                    </td>
                  </tr>
                ) : approvals.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState
                        icon={<CheckCircle2 size={44} />}
                        title={t("approval_empty")}
                        description={t("approval_empty_desc")}
                      />
                    </td>
                  </tr>
                ) : filteredApprovals.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState
                        icon={<Search size={44} />}
                        title={t("approval_no_match")}
                        description={t("approval_no_match_desc")}
                      />
                    </td>
                  </tr>
                ) : filteredApprovals.map((approval) => {
                  const isSelected = selectedApprovalId === approval.id;
                  return (
                    <tr key={approval.id} style={{ borderBottom: "1px solid var(--surface-border)", background: isSelected ? "rgba(59, 130, 246, 0.08)" : "transparent" }}>
                      <td style={{ padding: "0.9rem 1rem" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", color: "var(--text-main)", fontWeight: 800 }}>
                          {getApprovalIcon(approval.action)}
                          {t(`approval_action_${approval.action}`)}
                        </div>
                        <div style={{ marginTop: "0.25rem", color: "var(--text-muted)", fontSize: "0.76rem", lineHeight: 1.35, maxWidth: 320 }}>
                          {approval.summary}
                        </div>
                        {approval.error && (
                          <div style={{ marginTop: "0.25rem", color: "var(--danger)", fontSize: "0.74rem", lineHeight: 1.35 }}>
                            {approval.error}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "0.9rem 1rem", color: "var(--text-main)", fontFamily: "monospace", fontWeight: 700 }}>{approval.targetId}</td>
                      <td style={{ padding: "0.9rem 1rem", color: "var(--text-main)" }}>{approval.requester}</td>
                      <td style={{ padding: "0.9rem 1rem" }}>{renderApprovalStatus(approval.status)}</td>
                      <td style={{ padding: "0.9rem 1rem" }}>{renderApprovalSla(approval)}</td>
                      <td style={{ padding: "0.9rem 1rem", color: "var(--text-muted)", fontSize: "0.82rem" }}>{new Date(approval.createdAt).toLocaleString()}</td>
                      <td style={{ padding: "0.9rem 1rem", textAlign: "right" }}>
                        <button
                          className="btn btn-outline"
                          onClick={() => {
                            setSelectedApprovalId(approval.id);
                            setApprovalNote(approval.note || "");
                          }}
                          style={{ padding: "0.4rem 0.75rem", minHeight: 34 }}
                        >
                          <Eye size={14} />
                          {t("approval_view_detail")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <aside
            style={{
              border: "1px solid var(--surface-border)",
              borderRadius: "8px",
              background: "var(--header-bg)",
              padding: "1rem",
              display: "grid",
              gap: "0.85rem",
              minHeight: 420,
            }}
          >
            {selectedApproval ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
                  <div>
                    <h3 style={{ margin: 0, color: "var(--text-main)", fontSize: "0.98rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <FileJson size={16} color="var(--primary)" />
                      {t("approval_detail_title")}
                    </h3>
                    <p style={{ margin: "0.3rem 0 0", color: "var(--text-muted)", fontSize: "0.76rem", fontFamily: "monospace", overflowWrap: "anywhere" }}>
                      {selectedApproval.id}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {renderApprovalStatus(selectedApproval.status)}
                    <button className="btn btn-outline" onClick={() => handleApprovalExport(selectedApproval.id)} disabled={Boolean(exportingApprovalScope)} style={{ minHeight: 32, padding: "0.35rem 0.6rem", fontSize: "0.74rem" }}>
                      {exportingApprovalScope === `approval:${selectedApproval.id}` ? <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2 }} /> : <Download size={13} />}
                      {t("approval_export_selected")}
                    </button>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.65rem" }}>
                  {[
                    [t("approval_detail_action"), t(`approval_action_${selectedApproval.action}`)],
                    [t("approval_col_target"), selectedApproval.targetId],
                    [t("approval_col_requester"), selectedApproval.requester],
                    [t("approval_detail_reviewer"), selectedApproval.reviewer || "--"],
                    [t("approval_col_created"), new Date(selectedApproval.createdAt).toLocaleString()],
                    [t("approval_detail_reviewed"), selectedApproval.reviewedAt ? new Date(selectedApproval.reviewedAt).toLocaleString() : "--"],
                  ].map(([label, value]) => (
                    <div key={label} style={{ minWidth: 0 }}>
                      <div style={{ color: "var(--text-muted)", fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: 0 }}>{label}</div>
                      <div style={{ marginTop: "0.25rem", color: "var(--text-main)", fontSize: "0.82rem", fontWeight: 700, overflowWrap: "anywhere" }}>{value}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gap: "0.35rem" }}>
                  <strong style={{ color: "var(--text-main)", fontSize: "0.82rem" }}>{t("approval_detail_summary")}</strong>
                  <div style={{ color: "var(--text-secondary)", fontSize: "0.82rem", lineHeight: 1.45 }}>{selectedApproval.summary}</div>
                </div>

                {selectedApproval.status === "pending" ? (
                  <div
                    style={{
                      border: `1px solid ${APPROVAL_SLA_STYLE[getApprovalSlaTone(selectedApproval.createdAt)].color}`,
                      borderRadius: "8px",
                      background: APPROVAL_SLA_STYLE[getApprovalSlaTone(selectedApproval.createdAt)].bg,
                      padding: "0.75rem",
                      display: "grid",
                      gap: "0.4rem",
                    }}
                  >
                    <strong style={{ color: APPROVAL_SLA_STYLE[getApprovalSlaTone(selectedApproval.createdAt)].color, fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                      {getApprovalSlaTone(selectedApproval.createdAt) === "danger" ? <AlertTriangle size={14} /> : <Clock size={14} />}
                      {t("approval_sla_detail_title", { hours: getApprovalAgeHours(selectedApproval.createdAt) })}
                    </strong>
                    <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem", lineHeight: 1.45 }}>
                      {t(`approval_sla_detail_${getApprovalSlaTone(selectedApproval.createdAt)}`)}
                    </span>
                  </div>
                ) : null}

                <div style={{ display: "grid", gap: "0.55rem" }}>
                  <strong style={{ color: "var(--text-main)", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <FileJson size={14} />
                    {t("approval_payload")}
                  </strong>
                  <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", padding: "0.75rem", borderRadius: "8px", background: "var(--surface-hover)", color: "var(--text-secondary)", fontSize: "0.74rem", lineHeight: 1.45 }}>
                    {formatApprovalValue(selectedApproval.payload)}
                  </pre>
                </div>

                <div style={{ display: "grid", gap: "0.55rem" }}>
                  <strong style={{ color: "var(--text-main)", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <MessageSquare size={14} />
                    {t("approval_result")}
                  </strong>
                  <pre style={{ margin: 0, maxHeight: 140, overflow: "auto", padding: "0.75rem", borderRadius: "8px", background: "var(--surface-hover)", color: selectedApproval.error ? "var(--danger)" : "var(--text-secondary)", fontSize: "0.74rem", lineHeight: 1.45 }}>
                    {selectedApproval.error || formatApprovalValue(selectedApproval.result)}
                  </pre>
                </div>

                <div style={{ display: "grid", gap: "0.65rem", borderTop: "1px solid var(--surface-border)", paddingTop: "0.85rem" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                    <div>
                      <strong style={{ color: "var(--text-main)", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        <History size={14} />
                        {t("approval_audit_title")}
                      </strong>
                      <div style={{ marginTop: "0.25rem", color: "var(--text-muted)", fontSize: "0.74rem", lineHeight: 1.35 }}>
                        {t("approval_audit_desc")}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                      <span style={{ padding: "0.25rem 0.5rem", borderRadius: "999px", background: "var(--surface-hover)", color: "var(--text-secondary)", fontSize: "0.7rem", fontWeight: 800 }}>
                        {t("approval_audit_lifecycle_count", { count: approvalAuditData?.summary.lifecycle || 0 })}
                      </span>
                      <span style={{ padding: "0.25rem 0.5rem", borderRadius: "999px", background: "var(--surface-hover)", color: "var(--text-secondary)", fontSize: "0.7rem", fontWeight: 800 }}>
                        {t("approval_audit_execution_count", { count: approvalAuditData?.summary.execution || 0 })}
                      </span>
                    </div>
                  </div>

                  {isApprovalAuditLoading ? (
                    <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", overflow: "hidden" }}>
                      <LoadingRows columns={3} rows={2} />
                    </div>
                  ) : approvalAuditLogs.length === 0 ? (
                    <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "0.85rem", color: "var(--text-muted)", fontSize: "0.8rem", lineHeight: 1.45 }}>
                      {t("approval_audit_empty")}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: "0.5rem" }}>
                      {approvalAuditLogs.map((log, index) => (
                        <div
                          key={log.id}
                          style={{
                            border: "1px solid var(--surface-border)",
                            borderRadius: "8px",
                            background: isApprovalLifecycleLog(log, selectedApproval.id) ? "var(--surface-hover)" : "var(--header-bg)",
                            padding: "0.7rem",
                            display: "grid",
                            gap: "0.45rem",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.65rem", alignItems: "center" }}>
                            <span style={{ display: "flex", alignItems: "center", gap: "0.45rem", minWidth: 0 }}>
                              <strong style={{ width: 22, height: 22, borderRadius: "999px", background: "rgba(59, 130, 246, 0.12)", color: "var(--primary)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", flex: "0 0 auto" }}>{index + 1}</strong>
                              <span style={{ color: "var(--text-main)", fontSize: "0.8rem", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {renderAuditStepLabel(log, selectedApproval.id)}
                              </span>
                            </span>
                            <span style={{ color: log.level === "warning" ? "var(--danger)" : "var(--primary)", background: log.level === "warning" ? "rgba(239, 68, 68, 0.1)" : "rgba(59, 130, 246, 0.1)", padding: "0.2rem 0.45rem", borderRadius: "999px", fontSize: "0.68rem", fontWeight: 800 }}>
                              {formatAuditActionLabel(log.action)}
                            </span>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "0.65rem", alignItems: "center" }}>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ color: "var(--text-muted)", fontSize: "0.72rem", lineHeight: 1.35 }}>{new Date(log.timestamp).toLocaleString()}</div>
                              <div style={{ marginTop: "0.2rem", color: "var(--text-secondary)", fontSize: "0.74rem", fontFamily: "monospace", overflowWrap: "anywhere" }}>{log.targetId}</div>
                            </div>
                            <button className="btn btn-outline" onClick={() => setSelectedAuditLog(log)} style={{ minHeight: 32, padding: "0.35rem 0.6rem", fontSize: "0.74rem" }}>
                              <Braces size={13} />
                              {t("approval_audit_diff")}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {selectedApproval.status === "pending" ? (
                  <div style={{ display: "grid", gap: "0.65rem", borderTop: "1px solid var(--surface-border)", paddingTop: "0.85rem" }}>
                    <label style={{ display: "grid", gap: "0.4rem" }}>
                      <span style={{ color: "var(--text-main)", fontSize: "0.82rem", fontWeight: 800 }}>{t("approval_note")}</span>
                      <textarea
                        className="form-input"
                        value={approvalNote}
                        onChange={(event) => setApprovalNote(event.target.value.slice(0, 300))}
                        placeholder={t("approval_note_ph")}
                        rows={3}
                        style={{ width: "100%", resize: "vertical", minHeight: 78 }}
                      />
                    </label>
                    <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <button className="btn btn-outline" onClick={() => handleApprovalDecision(selectedApproval, "reject")} disabled={Boolean(reviewingApprovalId)} style={{ padding: "0.45rem 0.8rem", minHeight: 36 }}>
                        {reviewingApprovalId === `reject:${selectedApproval.id}` ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <X size={14} />}
                        {t("approval_reject")}
                      </button>
                      <button className="btn btn-primary" onClick={() => handleApprovalDecision(selectedApproval, "approve")} disabled={Boolean(reviewingApprovalId)} style={{ padding: "0.45rem 0.8rem", minHeight: 36 }}>
                        {reviewingApprovalId === `approve:${selectedApproval.id}` ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <CheckCircle2 size={14} />}
                        {t("approval_approve")}
                      </button>
                    </div>
                  </div>
                ) : selectedApproval.note ? (
                  <div style={{ display: "grid", gap: "0.35rem", borderTop: "1px solid var(--surface-border)", paddingTop: "0.85rem" }}>
                    <strong style={{ color: "var(--text-main)", fontSize: "0.82rem" }}>{t("approval_note")}</strong>
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.82rem", lineHeight: 1.45 }}>{selectedApproval.note}</div>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState
                icon={<FileJson size={44} />}
                title={t("approval_detail_empty")}
                description={t("approval_detail_empty_desc")}
              />
            )}
          </aside>
        </div>
      </section>

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
                    <button className="btn-icon" onClick={handleCreate} title={t("save")} disabled={savingAction === "create"}><Save size={18} color={newFormError ? "var(--warning)" : "var(--success)"} /></button>
                    <button className="btn-icon" onClick={() => setIsAdding(false)} title={t("cancel")} disabled={savingAction === "create"}><X size={18} color="var(--text-muted)" /></button>
                  </div>
                </td>
              </tr>
            )}

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
                      <button type="button" className="btn btn-primary" onClick={() => setIsAdding(true)}>
                        <Plus size={16} /> {t("users_new")}
                      </button>
                    }
                  />
                </td>
              </tr>
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
                          <button className="btn-icon" onClick={() => handleUpdate(u.username)} title={t("save")} disabled={savingAction === `update:${u.username}`}><Save size={18} color={editFormError ? "var(--warning)" : "var(--success)"} /></button>
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
                            <button className="btn-icon" onClick={() => handleDelete(u.username)} title={t("delete")} disabled={savingAction === `delete:${u.username}` || pendingDeleteUsername != null}><Trash2 size={16} color="var(--danger)" /></button>
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

    {selectedAuditLog && (
      <div className="modal-overlay" style={{ zIndex: 9999 }}>
        <div className="modal-content animate-fade-in" style={{ width: "900px", maxWidth: "95vw", borderRadius: "12px", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "1.35rem 1.75rem", borderBottom: "1px solid var(--surface-border)", background: "var(--surface-hover)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: "1.12rem", fontWeight: 700, color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Braces size={18} color="var(--primary)" />
                {t("approval_audit_diff_title")}
              </h2>
              <div style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: "0.35rem", display: "flex", gap: "0.65rem", flexWrap: "wrap" }}>
                <span>{t("audit_modal_ref")} <span style={{ fontFamily: "monospace" }}>{selectedAuditLog.id}</span></span>
                <span>{formatAuditActionLabel(selectedAuditLog.action)}</span>
                <span>{selectedAuditLog.targetId}</span>
              </div>
            </div>
            <button className="btn btn-outline" onClick={() => setSelectedAuditLog(null)}>{t("audit_modal_close")}</button>
          </div>

          <div style={{ padding: "1.5rem 1.75rem", flex: 1, overflowY: "auto", display: "flex", gap: "1rem" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ marginBottom: "0.5rem", fontWeight: 700, color: "var(--danger)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }} /> {t("audit_modal_old")}
              </div>
              <div style={{ background: "#1e1e1e", borderRadius: "8px", padding: "1rem", overflowX: "auto", minHeight: 260 }}>
                <pre style={{ margin: 0, color: "#d4d4d4", fontFamily: "monospace", fontSize: "0.8rem", lineHeight: 1.5 }}>
                  {selectedAuditLog.oldData ? JSON.stringify(selectedAuditLog.oldData, null, 2) : t("audit_modal_null_old")}
                </pre>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", color: "var(--surface-border)" }}>
              <ChevronRight size={30} />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ marginBottom: "0.5rem", fontWeight: 700, color: "var(--success)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }} /> {t("audit_modal_new")}
              </div>
              <div style={{ background: "#1e1e1e", borderRadius: "8px", padding: "1rem", overflowX: "auto", minHeight: 260 }}>
                <pre style={{ margin: 0, color: "#d4d4d4", fontFamily: "monospace", fontSize: "0.8rem", lineHeight: 1.5 }}>
                  {selectedAuditLog.newData ? JSON.stringify(selectedAuditLog.newData, null, 2) : t("audit_modal_null_new")}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
