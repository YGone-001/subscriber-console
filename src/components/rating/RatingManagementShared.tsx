"use client";
import React from "react";

export function StatusBadge({ tone, children }: { tone: "success" | "warning" | "muted"; children: React.ReactNode }) {
  const color = tone === "success" ? "var(--success)" : tone === "warning" ? "var(--warning)" : "var(--text-muted)";
  const background = tone === "success"
    ? "color-mix(in srgb, var(--success) 12%, var(--surface))"
    : tone === "warning"
      ? "rgba(245, 158, 11, 0.12)"
      : "var(--surface-hover)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 26, padding: "0 0.55rem", borderRadius: 6, background, color, fontSize: "0.74rem", fontWeight: 850 }}>
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
