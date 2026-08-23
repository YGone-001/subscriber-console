import { useI18n } from "@/components/I18nProvider";
import styles from "./UserDrawer.module.css";

function getPasswordScore(password: string) {
  if (!password) return 0;
  return Math.min(4, [
    password.length >= 8,
    password.length >= 12,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password) && /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length);
}

export function PasswordStrengthBar({ password }: { password: string }) {
  const { t } = useI18n();
  const score = getPasswordScore(password);
  const level = score <= 1 ? "weak" : score === 2 ? "fair" : score === 3 ? "good" : "strong";

  return (
    <div className={styles.passwordStrength}>
      <div
        className={styles.strengthTrack}
        role="meter"
        aria-label={t("users_password_strength")}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={t(`users_password_strength_${level}`)}
      >
        {[1, 2, 3, 4].map((segment) => <span key={segment} data-active={segment <= score || undefined} data-level={level} />)}
      </div>
      <span>{t("users_password_strength")}: <strong>{t(`users_password_strength_${level}`)}</strong></span>
    </div>
  );
}
