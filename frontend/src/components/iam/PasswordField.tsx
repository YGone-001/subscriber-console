import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { Field } from "@/components/ui/Field";
import styles from "./iam.module.css";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  setVisible: (visible: boolean) => void;
  placeholder?: string;
  onEnter?: () => void;
  disabled?: boolean;
  description?: string;
  autoComplete?: string;
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  setVisible,
  placeholder,
  onEnter,
  disabled,
  description,
  autoComplete = "new-password",
}: PasswordFieldProps) {
  const { t } = useI18n();
  const descriptionId = description ? `${id}-description` : undefined;
  const visibilityLabel = visible ? t("users_hide_password") : t("users_show_password");

  return (
    <Field htmlFor={id} label={label} description={description} descriptionId={descriptionId}>
      <div className={styles.passwordField}>
        <input
          id={id}
          type={visible ? "text" : "password"}
          className="form-input"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEnter?.();
          }}
          aria-describedby={descriptionId}
          disabled={disabled}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className={`btn-icon ${styles.passwordToggle}`}
          onClick={() => setVisible(!visible)}
          title={visibilityLabel}
          aria-label={visibilityLabel}
          disabled={disabled}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </Field>
  );
}
