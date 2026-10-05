/*
 * OCS page shell.
 *
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/ocs/OcsPageShell.tsx
 *
 * Adaptations: "use client" dropped; `@/components/...` aliases replaced with
 * relative imports for the Vite runtime. Structure and class names are unchanged.
 */
import type { ReactNode } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import PageHeader from '../ui/PageHeader';
import RefreshButton from '../ui/RefreshButton';

interface OcsPageShellProps {
  eyebrow: string;
  title: string;
  description: string;
  loading: boolean;
  onRefresh: () => void;
  kpiGrid: ReactNode;
  controls: ReactNode;
  tableContent: ReactNode;
  pagination: ReactNode;
  children?: ReactNode;
  /** When false, hides the readonly warning banner (default: true) */
  readonly?: boolean;
}

export default function OcsPageShell({
  eyebrow,
  title,
  description,
  loading,
  onRefresh,
  kpiGrid,
  controls,
  tableContent,
  pagination,
  children,
  readonly = true,
}: OcsPageShellProps) {
  const { t } = useI18n();

  return (
    <div className="container ocs-container">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        status={readonly ? <><Lock size={12} /> {t('ocs_readonly_badge')}</> : undefined}
        actions={<div className="ocs-header-actions">
          <RefreshButton
            loading={loading}
            onClick={onRefresh}
            label={t('refresh')}
            className="ocs-btn"
          />
        </div>}
      />

      {readonly && (
        <div className="ocs-readonly-banner">
          <ShieldAlert size={18} />
          <span>{t('ocs_readonly_notice')}</span>
        </div>
      )}

      {kpiGrid}

      {controls}

      <div className="dash-card ocs-table-card">
        <div className="ocs-table-wrapper">
          {tableContent}
        </div>
        {pagination}
      </div>

      {children}
    </div>
  );
}
