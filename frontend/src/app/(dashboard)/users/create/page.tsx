"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { PasswordField } from "@/components/iam/PasswordField";
import { usersApi } from "@/lib/api/users";
import { isPasswordStrong } from "@/lib/security";
import { VALID_ROLES, type RoleKey } from "@/types/iam";
import { PasswordStrengthBar } from "../components/PasswordStrengthBar";
import styles from "../components/UserDrawer.module.css";

export default function CreateUserPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleKey>("operator");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) { setError(t("users_err_username")); return; }
    if (!displayName.trim()) { setError(t("users_err_display_name")); return; }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t("users_err_email")); return; }
    if (!isPasswordStrong(password, trimmedUsername)) { setError(t("users_err_password")); return; }
    if (password !== confirmPassword) { setError(t("users_err_password_match")); return; }
    if (!VALID_ROLES.includes(role)) { setError(t("users_err_role")); return; }

    setSaving(true);
    setError("");
    try {
      await usersApi.create({
        username: trimmedUsername,
        password,
        displayName: displayName.trim() || undefined,
        email: email.trim() || undefined,
        role,
      });
      router.push("/users");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("users_err_create"));
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <Link href="/users" className="btn-icon" title={t("cancel")}>
            <ArrowLeft size={18} />
          </Link>
          <h1>{t("users_create_action")}</h1>
        </div>
      </div>

      <div className={styles.drawerBody} style={{ maxWidth: 560 }}>
        <section className={styles.formSection}>
          <h3>{t("users_form_basic")}</h3>
          <label>
            <span>{t("users_username")} *</span>
            <input type="text" className="form-input" value={username} maxLength={100} required
              onChange={(e) => { setUsername(e.target.value); setError(""); }} autoComplete="username" />
          </label>
          <label>
            <span>{t("users_display_name")} *</span>
            <input type="text" className="form-input" value={displayName} maxLength={100} required
              onChange={(e) => { setDisplayName(e.target.value); setError(""); }} autoComplete="name" />
          </label>
          <label>
            <span>{t("users_email")} <small>{t("users_optional")}</small></span>
            <input type="email" className="form-input" value={email} maxLength={254}
              onChange={(e) => { setEmail(e.target.value); setError(""); }} autoComplete="email" />
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t("users_form_role")}</h3>
          <label>
            <span>{t("users_role")} *</span>
            <select className="form-input" value={role} onChange={(e) => { setRole(e.target.value as RoleKey); setError(""); }}>
              {VALID_ROLES.map((r) => <option key={r} value={r}>{t(`users_${r}`)}</option>)}
            </select>
          </label>
        </section>

        <section className={styles.formSection}>
          <h3>{t("users_form_security")}</h3>
          <PasswordField id="create-user-password" label={t("users_password_new")}
            value={password} onChange={(v) => { setPassword(v); setError(""); }}
            visible={passwordVisible} setVisible={setPasswordVisible}
            placeholder={t("users_password_new")} autoComplete="new-password" />
          <PasswordStrengthBar password={password} />
          <PasswordField id="create-user-password-confirm" label={t("users_password_confirm")}
            value={confirmPassword} onChange={(v) => { setConfirmPassword(v); setError(""); }}
            visible={confirmVisible} setVisible={setConfirmVisible}
            placeholder={t("users_password_confirm")} autoComplete="new-password"
            onEnter={handleSubmit} />
        </section>

        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSubmit}>
            {saving ? t("saving") : t("users_create_action")}
          </button>
          <Link href="/users" className="btn btn-ghost">{t("cancel")}</Link>
        </div>
      </div>
    </div>
  );
}
