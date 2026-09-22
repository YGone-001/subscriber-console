"use client";

import React from "react";
import Link from "next/link";
import { Database, Phone, MessageSquare, Radio } from "lucide-react";
import { OcsBalanceMetrics, OcsSessionMetrics } from "./types";
import { BYTES_IN_GB } from "./utils";

interface OcsResourceStripProps {
  ocsBalances?: OcsBalanceMetrics;
  ocsSessions?: OcsSessionMetrics;
  t: (key: string, params?: Record<string, string | number>) => string;
}

function MiniProgressBar({ percent, color }: { percent: number; color: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="ocs-res-bar-track" aria-hidden="true">
      <div
        className="ocs-res-bar-fill"
        style={{
          width: `${clamped}%`,
          background: color,
        }}
      />
    </div>
  );
}

function toneCssColor(pct: number) {
  if (pct >= 85) return "var(--status-danger)";
  if (pct >= 65) return "var(--status-warning)";
  return "var(--status-success)";
}

export default function OcsResourceStrip({ ocsBalances, ocsSessions, t }: OcsResourceStripProps) {
  // Data pool
  const totalAllocGb = ocsBalances ? ocsBalances.totalDataAllocated / BYTES_IN_GB : 0;
  const dataUsedPct = ocsBalances?.dataUtilizationRate ?? 0;

  // Voice pool
  const voiceTotalMin = ocsBalances ? Math.round(ocsBalances.totalVoiceAllocated / 60) : 0;
  const voiceUsedMin = ocsBalances ? Math.round(ocsBalances.totalVoiceUsed / 60) : 0;
  const voiceUsedPct = voiceTotalMin > 0 ? Math.min(100, (voiceUsedMin / voiceTotalMin) * 100) : 0;

  // SMS pool
  const smsTotal = ocsBalances?.totalSmsAllocated ?? 0;
  const smsUsed = ocsBalances?.totalSmsUsed ?? 0;
  const smsUsedPct = smsTotal > 0 ? Math.min(100, (smsUsed / smsTotal) * 100) : 0;

  // Sessions
  const activeSessions = ocsSessions?.activeSessions ?? 0;
  const closingSessions = ocsSessions?.closingSessions ?? 0;
  const totalSessions = ocsSessions?.totalSessions ?? 0;

  return (
    <div className="ocs-resource-strip" role="list" aria-label="OCS Resource Overview">
      {/* Data Pool */}
      <Link href="/ocs/balances" className="ocs-res-cell" role="listitem">
        <div className="ocs-res-head">
          <div className="ocs-res-icon" style={{ color: "var(--chart-1)", background: "color-mix(in srgb, var(--chart-1) 9%, transparent)" }}>
            <Database size={14} />
          </div>
          <span className="ocs-res-label">{t("dash_ocs_kpi_utilization")}</span>
        </div>
        <div className="ocs-res-value" style={{ color: toneCssColor(dataUsedPct) }}>
          {dataUsedPct.toFixed(1)}<span>%</span>
        </div>
        <MiniProgressBar percent={dataUsedPct} color={toneCssColor(dataUsedPct)} />
        <div className="ocs-res-sub">{totalAllocGb.toFixed(0)} GB {t("dash_ocs_data_allocated").toLowerCase()}</div>
      </Link>

      {/* Voice Pool */}
      <Link href="/ocs/balances" className="ocs-res-cell" role="listitem">
        <div className="ocs-res-head">
          <div className="ocs-res-icon" style={{ color: "var(--chart-2)", background: "color-mix(in srgb, var(--chart-2) 9%, transparent)" }}>
            <Phone size={14} />
          </div>
          <span className="ocs-res-label">{t("dash_ocs_voice_pool")}</span>
        </div>
        <div className="ocs-res-value" style={{ color: toneCssColor(voiceUsedPct) }}>
          {voiceUsedPct.toFixed(1)}<span>%</span>
        </div>
        <MiniProgressBar percent={voiceUsedPct} color={toneCssColor(voiceUsedPct)} />
        <div className="ocs-res-sub">{voiceUsedMin.toLocaleString()} / {voiceTotalMin.toLocaleString()} {t("unit_mins")}</div>
      </Link>

      {/* SMS Pool */}
      <Link href="/ocs/balances" className="ocs-res-cell" role="listitem">
        <div className="ocs-res-head">
          <div className="ocs-res-icon" style={{ color: "var(--chart-3)", background: "color-mix(in srgb, var(--chart-3) 9%, transparent)" }}>
            <MessageSquare size={14} />
          </div>
          <span className="ocs-res-label">{t("dash_ocs_sms_pool")}</span>
        </div>
        <div className="ocs-res-value" style={{ color: toneCssColor(smsUsedPct) }}>
          {smsUsedPct.toFixed(1)}<span>%</span>
        </div>
        <MiniProgressBar percent={smsUsedPct} color={toneCssColor(smsUsedPct)} />
        <div className="ocs-res-sub">{smsUsed.toLocaleString()} / {smsTotal.toLocaleString()} {t("unit_msgs")}</div>
      </Link>

      {/* Sessions */}
      <Link href="/ocs/sessions" className="ocs-res-cell" role="listitem">
        <div className="ocs-res-head">
          <div className="ocs-res-icon" style={{ color: "var(--status-success)", background: "color-mix(in srgb, var(--status-success) 9%, transparent)" }}>
            <Radio size={14} />
          </div>
          <span className="ocs-res-label">{t("dash_ocs_active_sessions")}</span>
        </div>
        <div className="ocs-res-value">
          {activeSessions}
          {closingSessions > 0 && (
            <span className="ocs-res-closing-badge">{closingSessions} closing</span>
          )}
        </div>
        <div className="ocs-res-session-dots" aria-hidden="true">
          <span className="ocs-res-dot dot-active" />
          <span className="ocs-res-dot-label">{activeSessions} active</span>
          <span className="ocs-res-dot dot-closed" />
          <span className="ocs-res-dot-label">{totalSessions} total</span>
        </div>
      </Link>
    </div>
  );
}
