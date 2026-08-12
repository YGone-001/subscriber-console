import React from "react";
import { useI18n } from "@/components/I18nProvider";
import MetricStrip from "@/components/ui/MetricStrip";

interface SummaryItem {
  key: "all" | "active" | "restricted" | "lowTraffic";
  label: string;
  value: number;
  tone: "primary" | "success" | "danger" | "warning";
}

interface SubscriberSummaryPanelProps {
  summaryCards: readonly SummaryItem[];
  statusFilter: string;
  applyStatusFilter: (filter: "all" | "active" | "restricted" | "lowTraffic") => void;
}

export default function SubscriberSummaryPanel({
  summaryCards,
  statusFilter,
  applyStatusFilter
}: SubscriberSummaryPanelProps) {
  const { t } = useI18n();
  return (
    <MetricStrip
      ariaLabel={t("subscriber_summary_label")}
      items={summaryCards.map((item) => ({
        key: item.key,
        label: item.label,
        value: item.value,
        tone: item.tone,
        active: statusFilter === item.key,
        onClick: () => applyStatusFilter(item.key),
      }))}
    />
  );
}
