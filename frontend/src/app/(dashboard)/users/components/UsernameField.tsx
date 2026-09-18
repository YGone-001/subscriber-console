import { useEffect, useRef } from "react";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import type { UsernameAvailability } from "../types";
import styles from "./UserDrawer.module.css";

interface UsernameFieldProps {
  value: string;
  availability: UsernameAvailability;
  onChange: (value: string) => void;
  onCheck: (value: string) => Promise<void>;
  onResetAvailability: () => void;
}

export function UsernameField({ value, availability, onChange, onCheck, onResetAvailability }: UsernameFieldProps) {
  const { t } = useI18n();
  const checkTimerRef = useRef<number | null>(null);
  const statusId = "new-user-username-status";

  useEffect(() => () => {
    if (checkTimerRef.current != null) window.clearTimeout(checkTimerRef.current);
  }, []);

  const scheduleCheck = () => {
    if (checkTimerRef.current != null) window.clearTimeout(checkTimerRef.current);
    checkTimerRef.current = window.setTimeout(() => {
      void onCheck(value);
    }, 280);
  };

  const statusCopy = availability === "available"
    ? t("users_username_available")
    : availability === "taken"
      ? t("users_username_taken")
      : availability === "invalid"
        ? t("users_err_username")
        : availability === "error"
          ? t("users_username_check_error")
          : availability === "checking"
            ? t("users_username_checking")
            : t("users_username_hint");

  return (
    <label className={styles.usernameField}>
      <span>{t("users_username")}</span>
      <span className={styles.fieldControl}>
        <input
          type="text"
          className="form-input"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            onResetAvailability();
          }}
          onBlur={scheduleCheck}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={statusId}
          aria-invalid={availability === "taken" || availability === "invalid"}
        />
        {availability === "checking" ? <LoaderCircle className={styles.fieldSpinner} size={17} aria-hidden="true" /> : null}
        {availability === "available" ? <CheckCircle2 className={styles.fieldSuccess} size={17} aria-hidden="true" /> : null}
        {availability === "taken" || availability === "invalid" || availability === "error" ? <CircleAlert className={styles.fieldError} size={17} aria-hidden="true" /> : null}
      </span>
      <small id={statusId} className={availability === "available" ? styles.successText : availability === "taken" || availability === "invalid" ? styles.errorText : undefined} aria-live="polite">{statusCopy}</small>
    </label>
  );
}
