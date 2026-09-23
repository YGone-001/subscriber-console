"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import { ArrowLeft, Pencil, KeyRound, UserX } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { RoleBadge } from "@/components/iam/RoleBadge";
import { StatusBadge } from "@/components/iam/StatusBadge";
import { ConfirmActionPanel } from "@/components/OperationFeedback";
import { usersApi, type UserDetailResponse } from "@/lib/api/users";
import { fetcher } from "@/lib/fetcher";
import { usePermissions } from "@/hooks/usePermissions";
import { normalizeRole, normalizeStatus, formatDateTime, displayValue } from "../utils";
import { PasswordResetModal } from "../components/PasswordResetModal";
import type { RoleKey, UserStatus } from "@/types/iam";
import styles from "../components/UserDrawer.module.css";

export default function UserDetailPage() {
  const { t } = useI18n();
  const params = useParams<{ username: string }>();
  const router = useRouter();
  const username = decodeURIComponent(params.username);
  const { can } = usePermissions();
  const canManage = can("users.update");
  const canDisable = can("users.disable");
  const canResetPassword = can("users.reset-password");

  const { data, error, mutate } = useSWR<UserDetailResponse>(
    `/api/users/${encodeURIComponent(username)}`,
    fetcher,
  );

  const user = data?.user;
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleKey>("operator");
  const [status, setStatus] = useState<UserStatus>("active");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showResetModal, setShowResetModal] = useState(false);
  const [disableReason, setDisableReason] = useState("");
  const [notice, setNotice] = useState("");

  const startEdit = useCallback(() => {
    if (!user) return;
    setDisplayName(user.displayName || "");
    setEmail(user.email || "");
    setRole(normalizeRole(user.role));
    setStatus(normalizeStatus(user.status));
    setFormError("");
    setEditing(true);
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setFormError("");
    try {
      const payload: Record<string, unknown> = {};
      if (displayName !== (user.displayName || "")) payload.displayName = displayName;
      if (email !== (user.email || "")) payload.email = email;
      const currentRole = normalizeRole(user.role);
      const currentStatus = normalizeStatus(user.status);
      if (role !== currentRole) payload.role = role;
      if (status !== currentStatus) payload.status = status;
      if (!Object.keys(payload).length) { setEditing(false); setSaving(false); return; }
      await usersApi.update(username, payload);
      setEditing(false);
      setNotice(t("users_msg_updated"));
      await mutate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("users_err_update"));
    } finally {
      setSaving(false);
    }
  };

  const handleDisable = async () => {
    setSaving(true);
    setFormError("");
    try {
      await usersApi.disable(username, disableReason.trim() || undefined);
      setShowDisableConfirm(false);
      setDisableReason("");
      setNotice(t("users_msg_updated"));
      await mutate();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("users_err_update"));
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordReset = async (targetUsername: string, password: string, reason?: string) => {
    await usersApi.resetPassword(targetUsername, password, reason);
    setShowResetModal(false);
    setNotice(t("users_msg_updated"));
    await mutate();
  };

  if (error) {
    return (
      <div className="page">
        <div className="page-header">
          <Link href="/users" className="btn-icon" title={t("cancel")}><ArrowLeft size={18} /></Link>
          <h1>{t("users_title")}</h1>
        </div>
        <p style={{ color: "var(--danger)" }}>{error instanceof Error ? error.message : t("users_err_update")}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="page">
        <div className="page-header">
          <Link href="/users" className="btn-icon" title={t("cancel")}><ArrowLeft size={18} /></Link>
          <h1>{t("users_title")}</h1>
        </div>
        <p>{t("loading")}</p>
      </div>
    );
  }

  const normalizedRole = normalizeRole(user.role);
  const normalizedStatus = normalizeStatus(user.status);
  const isSelf = false; // self-protection enforced server-side

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <Link href="/users" className="btn-icon" title={t("cancel")}><ArrowLeft size={18} /></Link>
          <h1>{user.username}</h1>
          <RoleBadge role={normalizedRole} />
          <StatusBadge status={normalizedStatus} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {canManage && !editing ? (
            <button type="button" className="btn btn-ghost" onClick={startEdit}>
              <Pencil size={16} /> {t("users_edit_account")}
            </button>
          ) : null}
          {canResetPassword ? (
            <button type="button" className="btn btn-ghost" onClick={() => setShowResetModal(true)}>
              <KeyRound size={16} /> {t("users_reset_password")}
            </button>
          ) : null}
          {canDisable && normalizedStatus !== "disabled" && !isSelf ? (
            <button type="button" className="btn btn-danger" onClick={() => setShowDisableConfirm(true)}>
              <UserX size={16} /> {t("users_disable_account")}
            </button>
          ) : null}
        </div>
      </div>

      {notice ? <p style={{ color: "var(--success)" }}>{notice}</p> : null}
      {formError ? <p style={{ color: "var(--danger)" }}>{formError}</p> : null}

      <div className={styles.drawerBody} style={{ maxWidth: 640 }}>
        <section className={styles.formSection}>
          <h3>{t("users_form_basic")}</h3>
          <label>
            <span>{t("users_username")}</span>
            <input className="form-input" value={user.username} disabled />
          </label>
          <label>
            <span>{t("users_display_name")}</span>
            <input className="form-input" value={editing ? displayName : displayValue(user.displayName)}
              disabled={!editing} maxLength={100}
              onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label>
            <span>{t("users_email")}</span>
            <input type="email" className="form-input" value={editing ? email : displayValue(user.email)}
              disabled={!editing} maxLength={254}
              onChange={(e) => setEmail(e.target.value)} />
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t("users_form_role")}</h3>
          <label>
            <span>{t("users_role")}</span>
            {editing ? (
              <select className="form-input" value={role} onChange={(e) => setRole(e.target.value as RoleKey)}>
                {(data?.assignableRoles?.length ? data.assignableRoles : [normalizedRole]).map((r) => (
                  <option key={r} value={r}>{t(`users_${r}`)}</option>
                ))}
              </select>
            ) : (
              <input className="form-input" value={t(`users_${normalizedRole}`)} disabled />
            )}
          </label>
          <label>
            <span>{t("users_status")}</span>
            {editing ? (
              <select className="form-input" value={status} onChange={(e) => setStatus(e.target.value as UserStatus)}>
                <option value="active">{t("users_active")}</option>
                <option value="disabled">{t("users_disabled")}</option>
              </select>
            ) : (
              <input className="form-input" value={t(`users_${normalizedStatus}`)} disabled />
            )}
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t("users_security_state")}</h3>
          <label>
            <span>{t("users_session_version")}</span>
            <input className="form-input" value={String(user.security?.sessionVersion ?? "—")} disabled />
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t("users_form_basic")}</h3>
          <label>
            <span>{t("users_created")}</span>
            <input className="form-input" value={formatDateTime(user.createdAt)} disabled />
          </label>
          <label>
            <span>{t("users_updated_at")}</span>
            <input className="form-input" value={formatDateTime(user.updatedAt)} disabled />
          </label>
        </section>

        {editing ? (
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? t("saving") : t("save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>{t("cancel")}</button>
          </div>
        ) : null}
      </div>

      {showDisableConfirm ? (
        <ConfirmActionPanel
          presentation="modal"
          tone="warning"
          title={t("users_disable_account")}
          message={t("users_status_disable_desc")}
          confirmLabel={t("users_disable_account")}
          cancelLabel={t("cancel")}
          isWorking={saving}
          confirmDisabled={disableReason.trim().length < 3}
          onConfirm={handleDisable}
          onCancel={() => { setShowDisableConfirm(false); setDisableReason(""); }}
        >
          <div className={styles.confirmDetails}>
            <span>{t("users_confirm_object", { target: username })}</span>
            <label>
              {t("users_confirm_reason")}
              <textarea value={disableReason} onChange={(e) => setDisableReason(e.target.value)} rows={3} />
            </label>
          </div>
        </ConfirmActionPanel>
      ) : null}

      <PasswordResetModal
        username={username}
        open={showResetModal}
        onClose={() => setShowResetModal(false)}
        onSuccess={() => setNotice(t("users_msg_updated"))}
        onReset={handlePasswordReset}
      />
    </div>
  );
}
