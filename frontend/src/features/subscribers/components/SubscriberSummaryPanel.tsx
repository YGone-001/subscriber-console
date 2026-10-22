/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/subscribers/components/SubscriberSummaryPanel.tsx
 * Adaptations: the cards are now independent facets. Access status stays a
 * single dimension, while "unprovisioned" is a configuration facet rather than
 * a fourth access status.
 */
import React from "react";
import { useI18n } from '../../../providers/I18nProvider';
import MetricStrip from '../../../components/ui/MetricStrip';
import type { SubscriberSummaryKey } from '../types';

interface SummaryItem {
  key: SubscriberSummaryKey;
  label: string;
  value: number;
  tone: "primary" | "success" | "danger" | "warning";
}

interface SubscriberSummaryPanelProps {
  summaryCards: readonly SummaryItem[];
  activeCard: SubscriberSummaryKey | null;
  onSelect: (key: SubscriberSummaryKey) => void;
}

export default function SubscriberSummaryPanel({
  summaryCards,
  activeCard,
  onSelect,
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
        active: activeCard === item.key,
        onClick: () => onSelect(item.key),
      }))}
    />
  );
}
