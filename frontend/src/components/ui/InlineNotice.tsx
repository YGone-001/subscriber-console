/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/InlineNotice.tsx
 * Adaptations: "use client" dropped; CSS-module import repointed to ../../styles/modules/.
 */
import type { HTMLAttributes, ReactNode } from "react";
import styles from '../../styles/modules/InlineNotice.module.css';

type NoticeTone = "danger" | "warning" | "success" | "info";

interface InlineNoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  tone: NoticeTone;
  icon?: ReactNode;
  children: ReactNode;
}

export function InlineNotice({ tone, icon, children, className, role, ...props }: InlineNoticeProps) {
  const classes = className ? `${styles.notice} ${className}` : styles.notice;
  return (
    <div {...props} className={classes} data-tone={tone} role={role ?? (tone === "danger" ? "alert" : "status")}>
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      <div className={styles.content}>{children}</div>
    </div>
  );
}

export function ErrorNotice(props: Omit<InlineNoticeProps, "tone" | "role">) {
  return <InlineNotice {...props} tone="danger" role="alert" />;
}
