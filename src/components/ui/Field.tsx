import type { ReactNode } from "react";
import styles from "./Field.module.css";

interface FieldProps {
  htmlFor?: string;
  label: ReactNode;
  className?: string;
  labelClassName?: string;
  description?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

export function Field({ htmlFor, label, className, labelClassName, description, error, children }: FieldProps) {
  const fieldClassName = className ?? styles.field;
  const resolvedLabelClassName = labelClassName ?? styles.label;

  if (!htmlFor) {
    return (
      <label className={fieldClassName} data-invalid={error ? "true" : undefined}>
        <span className={resolvedLabelClassName}>{label}</span>
        {children}
        {description ? <p className={styles.description}>{description}</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </label>
    );
  }

  return (
    <div className={fieldClassName} data-invalid={error ? "true" : undefined}>
      <label className={resolvedLabelClassName} htmlFor={htmlFor}>{label}</label>
      {children}
      {description ? <p className={styles.description}>{description}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  );
}
