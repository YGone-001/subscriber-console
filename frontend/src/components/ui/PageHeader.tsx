import type { ReactNode } from 'react';

export type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
};

/**
 * Restored page header: status eyebrow, page title, optional subtitle and a
 * trailing action cluster. Presentation only.
 */
export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {eyebrow ? <p className="page-header-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="page-header-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
