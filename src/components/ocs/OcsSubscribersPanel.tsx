"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  Search,
  Users,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { DataTablePagination } from "@/components/ui/DataTablePagination";
import OcsPageShell from "./OcsPageShell";

interface OcsSubscriberRecord {
  id: string;
  imsi: string;
  msisdn: string;
  status: string;
  plan_id: string;
  created_at?: string;
  updated_at?: string;
}

export default function OcsSubscribersPanel() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortField, setSortField] = useState("updated_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const getAriaSort = (field: string): "ascending" | "descending" | undefined =>
    sortField === field ? (sortOrder === "asc" ? "ascending" : "descending") : undefined;

  const url = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      imsi: search.trim(),
      planId: planFilter,
      status: statusFilter,
      sortField,
      sortOrder,
    });
    return `/api/ocs/subscribers?${params.toString()}`;
  }, [page, limit, search, planFilter, statusFilter, sortField, sortOrder]);

  const { data, isLoading: loading, mutate: refresh } = useSWR(url, fetcher, {
    keepPreviousData: true,
  });

  const records: OcsSubscriberRecord[] = data?.records || [];
  const total: number = data?.total || 0;

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  };

  const formatTime = (iso?: string) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const kpiGrid = (
    <div className="ocs-kpi-grid">
      <div className="ocs-kpi-card">
        <Users size={20} />
        <div>
          <span className="ocs-kpi-value">{total}</span>
          <span className="ocs-kpi-label">{t("ocs_subscribers_total")}</span>
        </div>
      </div>
    </div>
  );

  const controls = (
    <div className="ocs-controls">
      <div className="ocs-search-wrap">
        <Search size={14} className="ocs-search-icon" />
        <input
          type="text"
          className="ocs-search-input"
          placeholder={t("ocs_subscribers_search_ph")}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
      </div>
      <select
        className="ocs-filter-select"
        value={statusFilter}
        onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
      >
        <option value="">{t("ocs_filter_all_statuses")}</option>
        <option value="active">active</option>
        <option value="suspended">suspended</option>
      </select>
    </div>
  );

  const tableContent = (
    <table className="ocs-table">
      <thead>
        <tr>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("imsi")}
            onClick={() => toggleSort("imsi")}
          >
            IMSI {sortField === "imsi" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th>{t("ocs_subscribers_col_msisdn")}</th>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("plan_id")}
            onClick={() => toggleSort("plan_id")}
          >
            {t("ocs_subscribers_col_plan")} {sortField === "plan_id" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("status")}
            onClick={() => toggleSort("status")}
          >
            {t("status")} {sortField === "status" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
          <th
            className="ocs-th-sortable"
            aria-sort={getAriaSort("updated_at")}
            onClick={() => toggleSort("updated_at")}
          >
            {t("ocs_subscribers_col_updated")} {sortField === "updated_at" ? (sortOrder === "asc" ? "↑" : "↓") : ""}
          </th>
        </tr>
      </thead>
      <tbody>
        {records.length === 0 ? (
          <tr><td colSpan={5} className="ocs-empty-cell">{t("no_data")}</td></tr>
        ) : (
          records.map((r) => (
            <tr key={r.id}>
              <td className="ocs-imsi-cell"><code>{r.imsi}</code></td>
              <td>{r.msisdn || "—"}</td>
              <td><span className="ocs-plan-badge">{r.plan_id}</span></td>
              <td>
                <span className={`ocs-status-badge ocs-status-${r.status}`}>
                  {r.status}
                </span>
              </td>
              <td className="ocs-time-cell">{formatTime(r.updated_at)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );

  const pagination = (
    <DataTablePagination
      page={page}
      totalPages={data?.totalPages || 1}
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
      onPageSizeChange={(nextLimit: number) => {
        setLimit(nextLimit);
        setPage(1);
      }}
    />
  );

  return (
    <OcsPageShell
      eyebrow={t("nav_ocs")}
      title={t("ocs_subscribers_title")}
      description={t("ocs_subscribers_desc")}
      loading={loading}
      onRefresh={refresh}
      kpiGrid={kpiGrid}
      controls={controls}
      tableContent={tableContent}
      pagination={pagination}
    />
  );
}
