import React from "react";
import { useI18n } from "@/components/I18nProvider";

interface SummaryItem {
  key: "all" | "active" | "restricted" | "lowTraffic";
  label: string;
  value: number;
  tone: "primary" | "success" | "danger" | "warning";
}

interface SubscriberSummaryPanelProps {
  summaryCards: SummaryItem[];
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
    <section className="subscriber-summary-panel" aria-label={t("subscriber_summary_label")}>
      {summaryCards.map((item) => {
        const isActive = statusFilter === item.key;
        return (
          <button
            key={item.key}
            type="button"
            className={`subscriber-summary-card subscriber-summary-${item.tone}${isActive ? " active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              applyStatusFilter(item.key);
            }}
            aria-pressed={isActive}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </button>
        );
      })}
    </section>
  );
}
