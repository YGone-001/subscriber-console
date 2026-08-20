"use client";

import type { ReactNode } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import PageHeader from "@/components/ui/PageHeader";
import RefreshButton from "@/components/ui/RefreshButton";

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
}: OcsPageShellProps) {
  const { t } = useI18n();

  return (
    <div className="ocs-container">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        status={<><Lock size={12} /> {t("ocs_readonly_badge")}</>}
        actions={<div className="ocs-header-actions">
          <RefreshButton
            loading={loading}
            onClick={onRefresh}
            label={t("refresh")}
            className="ocs-btn"
          />
        </div>}
      />

      <div className="ocs-readonly-banner">
        <ShieldAlert size={18} />
        <span>{t("ocs_readonly_notice")}</span>
      </div>

      {kpiGrid}

      {controls}

      <div className="ocs-table-card">
        <div className="ocs-table-wrapper">
          {tableContent}
        </div>
        {pagination}
      </div>

      {children}
    </div>
  );
}
