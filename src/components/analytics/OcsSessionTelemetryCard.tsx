"use client";

import React from "react";
import Link from "next/link";
import { Radio, ArrowUpRight, Server, Layers, AlertCircle } from "lucide-react";
import { OcsReservationMetrics, OcsSessionMetrics } from "./types";
import { BYTES_IN_GB } from "./utils";
import CountUpNumber from "./CountUpNumber";

interface OcsSessionTelemetryCardProps {
  sessions?: OcsSessionMetrics;
  reservations?: OcsReservationMetrics;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export default function OcsSessionTelemetryCard({
  sessions,
  reservations,
  t,
}: OcsSessionTelemetryCardProps) {
  if (!sessions) return null;

  const totalSessions = sessions.totalSessions || 0;
  const activeSessions = sessions.activeSessions || 0;
  const closingSessions = sessions.closingSessions || 0;
  const closedSessions = sessions.closedSessions || 0;

  const gyCount = sessions.interfaceGyCount || 0;
  const roCount = sessions.interfaceRoCount || 0;
  const totalInterfaces = gyCount + roCount || 1;
  const gyPct = ((gyCount / totalInterfaces) * 100).toFixed(1);
  const roPct = ((roCount / totalInterfaces) * 100).toFixed(1);

  const grantedGb = (sessions.totalGrantedOctets || 0) / BYTES_IN_GB;
  const usedGb = (sessions.totalUsedOctets || 0) / BYTES_IN_GB;

  const activeReservations = reservations?.activeReservations || 0;
  const reservedOctetsMb = ((reservations?.totalReservedOctets || 0) / (1024 * 1024)).toFixed(1);
  const orphanedReservations = reservations?.orphanedReservations || 0;

  return (
    <div className="analytics-ocs-card analytics-panel">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <div className="analytics-ocs-icon" style={{ color: "#1cc88a", background: "rgba(28, 200, 138, 0.12)" }}>
            <Radio size={20} />
          </div>
          <div>
            <h3>{t("dash_ocs_session_telemetry_title")}</h3>
            <p className="analytics-ocs-subtitle">{t("dash_ocs_session_telemetry_subtitle")}</p>
          </div>
        </div>
        <div className="analytics-ocs-header-actions">
          <div className="analytics-live-pulse-badge">
            <span className="live-pulse-dot" />
            <span>{t("dash_ocs_live_engine")}</span>
          </div>
          <Link href="/ocs/sessions" className="analytics-ocs-link-btn">
            <span>{t("dash_ocs_view_sessions")}</span>
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>

      <div className="analytics-ocs-body">
        {/* Sessions State Grid */}
        <div className="analytics-ocs-session-stats-grid">
          <div className="analytics-ocs-session-stat-card active-stat">
            <div className="stat-label-wrap">
              <span className="stat-dot dot-active" />
              <span>{t("dash_ocs_active_sessions")}</span>
            </div>
            <strong><CountUpNumber value={activeSessions} /></strong>
            <span className="stat-sub">{t("dash_ocs_in_flight_sessions")}</span>
          </div>

          <div className="analytics-ocs-session-stat-card closing-stat">
            <div className="stat-label-wrap">
              <span className="stat-dot dot-closing" />
              <span>{t("dash_ocs_closing_sessions")}</span>
            </div>
            <strong><CountUpNumber value={closingSessions} /></strong>
            <span className="stat-sub">{t("dash_ocs_releasing_sessions")}</span>
          </div>

          <div className="analytics-ocs-session-stat-card closed-stat">
            <div className="stat-label-wrap">
              <span className="stat-dot dot-closed" />
              <span>{t("dash_ocs_closed_sessions")}</span>
            </div>
            <strong><CountUpNumber value={closedSessions} /></strong>
            <span className="stat-sub">{totalSessions} {t("dash_ocs_total_observed")}</span>
          </div>
        </div>

        {/* Interface & APN Breakdown */}
        <div className="analytics-ocs-telemetry-middle">
          {/* Gy vs Ro Interface Split */}
          <div className="analytics-ocs-interface-card">
            <div className="interface-card-header">
              <div className="interface-title">
                <Server size={15} />
                <span>{t("dash_ocs_interfaces_split")}</span>
              </div>
              <span className="interface-count-text">Gy: {gyCount} | Ro: {roCount}</span>
            </div>
            <div className="analytics-ocs-split-bar">
              <div className="split-gy" style={{ width: `${gyPct}%` }} title={`Gy: ${gyCount} (${gyPct}%)`} />
              <div className="split-ro" style={{ width: `${roPct}%` }} title={`Ro: ${roCount} (${roPct}%)`} />
            </div>
            <div className="split-legend">
              <span><span className="legend-dot dot-gy" /> Gy (3GPP Data: {gyPct}%)</span>
              <span><span className="legend-dot dot-ro" /> Ro (Voice/SMS: {roPct}%)</span>
            </div>
          </div>

          {/* In-flight Quota & Reservations Card */}
          <div className="analytics-ocs-reservations-card">
            <div className="res-card-header">
              <div className="res-title">
                <Layers size={15} />
                <span>{t("dash_ocs_inflight_reservations")}</span>
              </div>
              {orphanedReservations > 0 ? (
                <span className="orphaned-badge" title={t("dash_ocs_orphaned_tip")}>
                  <AlertCircle size={13} /> {orphanedReservations} {t("dash_ocs_orphaned_short")}
                </span>
              ) : (
                <span className="res-ok-badge">{t("dash_ocs_reservations_synced")}</span>
              )}
            </div>
            <div className="res-metrics-row">
              <div>
                <span className="res-sublabel">{t("dash_ocs_active_reservations")}</span>
                <strong>{activeReservations}</strong>
              </div>
              <div>
                <span className="res-sublabel">{t("dash_ocs_inflight_reserved_volume")}</span>
                <strong>{reservedOctetsMb} <small>MB</small></strong>
              </div>
              <div>
                <span className="res-sublabel">{t("dash_ocs_granted_used_volume")}</span>
                <strong>{grantedGb.toFixed(2)} / {usedGb.toFixed(2)} <small>GB</small></strong>
              </div>
            </div>
          </div>
        </div>

        {/* APN Distribution Pills */}
        {sessions.apnDistribution && sessions.apnDistribution.length > 0 && (
          <div className="analytics-ocs-apn-row">
            <span className="apn-row-label">{t("dash_ocs_apn_distribution")}:</span>
            <div className="apn-pills-wrap">
              {sessions.apnDistribution.map((item) => (
                <div key={item.apn} className="apn-pill">
                  <span className="apn-name">{item.apn}</span>
                  <span className="apn-count">{item.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
