"use client";

import React from "react";
import Link from "next/link";
import { Database, ShieldCheck, AlertTriangle, ArrowUpRight, Phone, MessageSquare } from "lucide-react";
import { OcsBalanceMetrics } from "./types";
import { BYTES_IN_GB } from "./utils";
import CountUpNumber from "./CountUpNumber";

interface OcsBalanceCapacityCardProps {
  metrics?: OcsBalanceMetrics;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export default function OcsBalanceCapacityCard({ metrics, t }: OcsBalanceCapacityCardProps) {
  if (!metrics) return null;

  const totalAllocatedGb = metrics.totalDataAllocated / BYTES_IN_GB;
  const usedGb = metrics.totalDataUsed / BYTES_IN_GB;
  const reservedGb = metrics.totalDataReserved / BYTES_IN_GB;
  const availableGb = metrics.totalDataAvailable / BYTES_IN_GB;

  const usedPct = totalAllocatedGb > 0 ? (usedGb / totalAllocatedGb) * 100 : 0;
  const reservedPct = totalAllocatedGb > 0 ? (reservedGb / totalAllocatedGb) * 100 : 0;
  const availablePct = totalAllocatedGb > 0 ? Math.max(0, 100 - usedPct - reservedPct) : 100;

  const voiceTotalMin = Math.round(metrics.totalVoiceAllocated / 60);
  const voiceUsedMin = Math.round(metrics.totalVoiceUsed / 60);
  const voiceAvailableMin = Math.round(metrics.totalVoiceAvailable / 60);

  const utilizationRate = metrics.dataUtilizationRate;
  const utilizationTone = utilizationRate >= 85 ? "danger" : utilizationRate >= 65 ? "warning" : "normal";

  return (
    <div className="analytics-ocs-card analytics-panel">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <div className="analytics-ocs-icon" style={{ color: "#4e73df", background: "rgba(78, 115, 223, 0.12)" }}>
            <Database size={20} />
          </div>
          <div>
            <h3>{t("dash_ocs_balance_pool_title")}</h3>
            <p className="analytics-ocs-subtitle">{t("dash_ocs_balance_pool_subtitle")}</p>
          </div>
        </div>
        <div className="analytics-ocs-header-actions">
          {metrics.allInvariantsOk ? (
            <span className="analytics-ocs-badge-success" title={t("dash_ocs_invariant_ok_tip")}>
              <ShieldCheck size={14} />
              {t("dash_ocs_invariant_ok")}
            </span>
          ) : (
            <Link href="/ocs/balances" className="analytics-ocs-badge-danger" title={t("dash_ocs_invariant_broken_tip", { count: metrics.brokenInvariantCount })}>
              <AlertTriangle size={14} />
              {t("dash_ocs_invariant_broken", { count: metrics.brokenInvariantCount })}
            </Link>
          )}
          <Link href="/ocs/balances" className="analytics-ocs-link-btn">
            <span>{t("dash_ocs_view_balances")}</span>
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>

      <div className="analytics-ocs-body">
        {/* Top Capacity Metrics */}
        <div className="analytics-ocs-capacity-summary">
          <div className="analytics-ocs-metric-item">
            <span className="analytics-ocs-metric-label">{t("dash_ocs_data_allocated")}</span>
            <strong className="analytics-ocs-metric-val">
              <CountUpNumber value={totalAllocatedGb} decimals={2} /> GB
            </strong>
            <span className="analytics-ocs-subtext">{metrics.totalSubscribers} {t("dash_ops_subscribers", { count: "" }).trim()}</span>
          </div>

          <div className="analytics-ocs-metric-item">
            <span className="analytics-ocs-metric-label">{t("dash_ocs_data_used")}</span>
            <strong className="analytics-ocs-metric-val text-used">
              <CountUpNumber value={usedGb} decimals={2} /> GB
            </strong>
            <span className="analytics-ocs-subtext">{usedPct.toFixed(1)}%</span>
          </div>

          <div className="analytics-ocs-metric-item">
            <span className="analytics-ocs-metric-label">{t("dash_ocs_data_reserved")}</span>
            <strong className="analytics-ocs-metric-val text-reserved">
              <CountUpNumber value={reservedGb} decimals={2} /> GB
            </strong>
            <span className="analytics-ocs-subtext">{reservedPct.toFixed(1)}%</span>
          </div>

          <div className="analytics-ocs-metric-item">
            <span className="analytics-ocs-metric-label">{t("dash_ocs_data_available")}</span>
            <strong className="analytics-ocs-metric-val text-available">
              <CountUpNumber value={availableGb} decimals={2} /> GB
            </strong>
            <span className="analytics-ocs-subtext">{availablePct.toFixed(1)}%</span>
          </div>
        </div>

        {/* Multi-Segment Capacity Bar */}
        <div className="analytics-ocs-bar-container">
          <div className="analytics-ocs-bar-header">
            <span>{t("dash_ocs_utilization_bar_label")}</span>
            <strong className={`analytics-ocs-utilization-badge tone-${utilizationTone}`}>
              {utilizationRate.toFixed(1)}% {t("dash_ocs_used_label")}
            </strong>
          </div>
          <div className="analytics-ocs-multi-bar">
            <div
              className="analytics-ocs-bar-seg seg-used"
              style={{ width: `${Math.min(100, usedPct)}%` }}
              title={`${t("dash_ocs_data_used")}: ${usedGb.toFixed(2)} GB (${usedPct.toFixed(1)}%)`}
            />
            <div
              className="analytics-ocs-bar-seg seg-reserved"
              style={{ width: `${Math.min(100 - usedPct, reservedPct)}%` }}
              title={`${t("dash_ocs_data_reserved")}: ${reservedGb.toFixed(2)} GB (${reservedPct.toFixed(1)}%)`}
            />
            <div
              className="analytics-ocs-bar-seg seg-available"
              style={{ width: `${Math.min(100, availablePct)}%` }}
              title={`${t("dash_ocs_data_available")}: ${availableGb.toFixed(2)} GB (${availablePct.toFixed(1)}%)`}
            />
          </div>
          <div className="analytics-ocs-bar-legend">
            <span className="legend-item"><span className="legend-dot dot-used" /> {t("dash_ocs_data_used")}</span>
            <span className="legend-item"><span className="legend-dot dot-reserved" /> {t("dash_ocs_data_reserved")}</span>
            <span className="legend-item"><span className="legend-dot dot-available" /> {t("dash_ocs_data_available")}</span>
          </div>
        </div>

        {/* Secondary Telemetry: Voice & SMS */}
        <div className="analytics-ocs-secondary-grid">
          <div className="analytics-ocs-secondary-card">
            <div className="analytics-ocs-sec-header">
              <Phone size={16} className="text-secondary-icon" />
              <span>{t("dash_ocs_voice_pool")}</span>
            </div>
            <div className="analytics-ocs-sec-content">
              <strong>{voiceAvailableMin} <small>{t("unit_mins")}</small></strong>
              <span className="analytics-ocs-sec-sub">
                {t("dash_ocs_voice_used_ratio", { used: voiceUsedMin, total: voiceTotalMin })}
              </span>
            </div>
          </div>

          <div className="analytics-ocs-secondary-card">
            <div className="analytics-ocs-sec-header">
              <MessageSquare size={16} className="text-secondary-icon" />
              <span>{t("dash_ocs_sms_pool")}</span>
            </div>
            <div className="analytics-ocs-sec-content">
              <strong>{metrics.totalSmsAvailable} <small>{t("unit_msgs")}</small></strong>
              <span className="analytics-ocs-sec-sub">
                {t("dash_ocs_sms_used_ratio", { used: metrics.totalSmsUsed, total: metrics.totalSmsAllocated })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
