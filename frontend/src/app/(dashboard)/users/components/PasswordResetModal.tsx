"use client";

import { useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { PasswordField } from "@/components/iam/PasswordField";
import { ConfirmActionPanel } from "@/components/OperationFeedback";
import { isPasswordStrong } from "@/lib/security";
import { PasswordStrengthBar } from "./PasswordStrengthBar";
import styles from "./UserDrawer.module.css";

interface PasswordResetModalProps {
  username: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onReset: (username: string, password: string, reason?: string) => Promise<void>;
}

export function PasswordResetModal({ username, open, onClose, onSuccess, onReset }: PasswordResetModalProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setPassword("");
    setConfirmPassword("");
    setPasswordVisible(false);
    setConfirmVisible(false);
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!isPasswordStrong(password, username)) {
      setError(t("users_err_password"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("users_err_password_match"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onReset(username, password);
      reset();
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("users_err_update"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfirmActionPanel
      presentation="modal"
      tone="warning"
      title={t("users_reset_password")}
      message={t("users_reset_password_desc", { username })}
      confirmLabel={t("users_reset_password")}
      cancelLabel={t("cancel")}
      isWorking={saving}
      confirmDisabled={!password || !confirmPassword}
      onConfirm={handleSubmit}
      onCancel={handleClose}
    >
      <div className={styles.formSection}>
        <PasswordField
          id="reset-password"
          label={t("users_password_new")}
          value={password}
          onChange={(v) => { setPassword(v); setError(""); }}
          visible={passwordVisible}
          setVisible={setPasswordVisible}
          placeholder={t("users_password_new")}
          autoComplete="new-password"
        />
        <PasswordStrengthBar password={password} />
        <PasswordField
          id="reset-password-confirm"
          label={t("users_password_confirm")}
          value={confirmPassword}
          onChange={(v) => { setConfirmPassword(v); setError(""); }}
          visible={confirmVisible}
          setVisible={setConfirmVisible}
          placeholder={t("users_password_confirm")}
          autoComplete="new-password"
          onEnter={handleSubmit}
        />
        {error ? <p className={styles.sectionDescription} style={{ color: "var(--danger)" }}>{error}</p> : null}
      </div>
    </ConfirmActionPanel>
  );
}
