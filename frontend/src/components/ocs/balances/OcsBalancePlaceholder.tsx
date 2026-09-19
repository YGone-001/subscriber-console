"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { ShieldAlert, Wallet } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import { formatBytes } from "@/lib/unitParser";
import OcsPageShell from "../OcsPageShell";

export default function OcsBalancePlaceholder() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const url = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    return `/api/ocs/balances?${params.toString()}`;
  }, [page, limit]);

  const { data, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  const records = data?.records || [];
  const total = data?.total || 0;
  const summary = data?.summary || {};

  const kpiGrid = (
    <div className="ocs-dashboard-grid">
      <div className="ocs-dashboard-card">
        <div className="ocs-dashboard-card-icon"><Wallet size={20} /></div>
        <div className="ocs-dashboard-card-content">
          <span className="ocs-dashboard-card-value">{total}</span>
          <span className="ocs-dashboard-card-label">{t("ocs_balance_total_accounts")}</span>
        </div>
      </div>
    </div>
  );

  const tableContent = (
    <>
      <div className="ocs-readonly-banner">
        <ShieldAlert size={18} />
        <span>{t("ocs_balance_adjustment_notice")}</span>
      </div>
      <table className="ocs-table">
        <caption className="sr-only">{t("ocs_balances_title")}</caption>
        <thead>
          <tr>
            <th>IMSI</th>
            <th>{t("ocs_col_data_available")}</th>
            <th>{t("ocs_col_voice_avail")}</th>
            <th>{t("ocs_col_sms_avail")}</th>
            <th>{t("ocs_col_status")}</th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 && !loading ? (
            <tr><td colSpan={5} className="ocs-empty-cell">{t("no_data")}</td></tr>
          ) : (
            records.map((r: any) => (
              <tr key={r.id}>
                <td className="ocs-mono">{r.imsi}</td>
                <td className="ocs-mono">{formatBytes(r.data_available)}</td>
                <td className="ocs-mono">{r.voice_available}s</td>
                <td className="ocs-mono">{r.sms_available}</td>
                <td>
                  <span className={`ocs-status-badge ocs-status-${r.status}`}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );

  const pagination = (
    <DataTablePagination
      page={page}
      totalPages={Math.ceil(total / limit) || 1}
      total={total}
      pageSize={limit}
      visibleCount={records.length}
      labels={{
        showing: t("showing"),
        to: t("to"),
        of: t("of"),
        entries: t("entries"),
        previous: t("prev"),
        next: t("next"),
        perPage: t("per_page"),
      }}
      onPageChange={setPage}
      onPageSizeChange={(nextLimit: number) => { setLimit(nextLimit); setPage(1); }}
    />
  );

  return (
    <OcsPageShell
      eyebrow={t("nav_ocs")}
      title={t("ocs_balances_title")}
      description={t("ocs_balances_desc")}
      loading={loading}
      onRefresh={() => refresh()}
      kpiGrid={kpiGrid}
      controls={null}
      tableContent={tableContent}
      pagination={pagination}
    />
  );
}
