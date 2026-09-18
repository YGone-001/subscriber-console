"use client";
import React from "react";

export function StatusBadge({ tone, children }: { tone: "success" | "warning" | "muted"; children: React.ReactNode }) {
  const color = tone === "success" ? "var(--success)" : tone === "warning" ? "var(--warning)" : "var(--text-muted)";
  const background = tone === "success"
    ? "color-mix(in srgb, var(--success) 12%, var(--surface))"
    : tone === "warning"
      ? "var(--status-warning-soft)"
      : "var(--surface-hover)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 26, padding: "0 0.55rem", borderRadius: "var(--ref-radius-compact)", background, color, fontSize: "var(--ref-font-size-label)", fontWeight: 850 }}>
      {children}
    </span>
  );
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}
