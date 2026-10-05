/*
 * Page header primitive.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ui/PageHeader.tsx
 *
 * The reference implementation is the default export and is styled by
 * ConsolePrimitives.module.css. The named `PageHeader` export is a
 * backward-compatible adapter for the earlier local API
 * (`eyebrow` / `title` / `subtitle` / `actions`) so existing call sites keep
 * working unchanged; it maps `subtitle` onto the reference `description` slot.
 */
import type { ReactNode } from 'react';
import styles from '../../styles/modules/ConsolePrimitives.module.css';

export type PageHeaderTone = 'default' | 'healthy' | 'warning' | 'danger';

export type ConsolePageHeaderProps = {
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

export default function ConsolePageHeader({
  title,
  description,
  eyebrow,
  icon,
  actions,
  status,
  tone = 'default',
  compact = false,
  className,
}: ConsolePageHeaderProps) {
  const classes = [styles.pageHeader, compact ? styles.pageHeaderCompact : '', className || '']
    .filter(Boolean)
    .join(' ');

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

/** Backward-compatible adapter for the earlier local PageHeader API. */
export type PageHeaderProps = {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  status?: ReactNode;
  tone?: PageHeaderTone;
  compact?: boolean;
  className?: string;
};

export function PageHeader({ subtitle, description, ...rest }: PageHeaderProps) {
  return <ConsolePageHeader {...rest} description={description ?? subtitle} />;
}
