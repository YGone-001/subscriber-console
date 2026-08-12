import type { ReactNode } from "react";
import styles from "./ConsolePrimitives.module.css";

export type PageHeaderTone = "default" | "healthy" | "warning" | "danger";

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  tone?: PageHeaderTone;
  compact?: boolean;
  className?: string;
};

export default function PageHeader({
  title,
  description,
  eyebrow,
  icon,
  actions,
  status,
  tone = "default",
  compact = false,
  className,
}: PageHeaderProps) {
  const classes = [styles.pageHeader, compact ? styles.pageHeaderCompact : "", className || ""]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={classes} data-tone={tone}>
      <div className={styles.pageHeaderCopy}>
        {eyebrow ? <div className={styles.eyebrow}>{eyebrow}</div> : null}
        <div className={styles.titleRow}>
          {icon ? <span className={styles.icon}>{icon}</span> : null}
          <h1 className={styles.title}>{title}</h1>
        </div>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions || status ? (
        <div className={styles.actions}>
          {status ? <div className={styles.status}>{status}</div> : null}
          {actions}
        </div>
      ) : null}
    </header>
  );
}
