"use client";

import React from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";

export type FeedbackTone = "info" | "success" | "warning" | "danger";

const toneStyles: Record<FeedbackTone, { bg: string; border: string; color: string; soft: string }> = {
  info: {
    bg: "rgba(59, 130, 246, 0.1)",
    border: "rgba(59, 130, 246, 0.25)",
    color: "#60a5fa",
    soft: "rgba(59, 130, 246, 0.16)",
  },
  success: {
    bg: "rgba(16, 185, 129, 0.1)",
    border: "rgba(16, 185, 129, 0.26)",
    color: "#34d399",
    soft: "rgba(16, 185, 129, 0.16)",
  },
  warning: {
    bg: "rgba(245, 158, 11, 0.12)",
    border: "rgba(245, 158, 11, 0.28)",
    color: "#fbbf24",
    soft: "rgba(245, 158, 11, 0.16)",
  },
  danger: {
    bg: "rgba(239, 68, 68, 0.12)",
    border: "rgba(239, 68, 68, 0.28)",
    color: "#f87171",
    soft: "rgba(239, 68, 68, 0.16)",
  },
};

function ToneIcon({ tone, size = 18 }: { tone: FeedbackTone; size?: number }) {
  if (tone === "success") return <CheckCircle2 size={size} />;
  if (tone === "danger" || tone === "warning") return <AlertTriangle size={size} />;
  return <Info size={size} />;
}

export function OperationNotice({
  tone,
  title,
  message,
  onClose,
}: {
  tone: FeedbackTone;
  title?: string;
  message: string;
  onClose?: () => void;
}) {
  const style = toneStyles[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.75rem",
        padding: "0.85rem 1rem",
        marginBottom: "1rem",
        borderRadius: "8px",
        border: `1px solid ${style.border}`,
        background: style.bg,
        color: "var(--text-main)",
      }}
    >
      <div style={{ color: style.color, display: "flex", paddingTop: "0.1rem" }}>
        <ToneIcon tone={tone} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 800, fontSize: "0.92rem", marginBottom: "0.15rem" }}>{title}</div>}
        <div style={{ color: "var(--text-secondary)", fontSize: "0.86rem", lineHeight: 1.5 }}>{message}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notice"
          style={{
            width: 28,
            height: 28,
            borderRadius: "6px",
            border: "none",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
          }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function ConfirmActionPanel({
  tone = "danger",
  title,
  message,
  confirmLabel,
  cancelLabel,
  isWorking,
  onConfirm,
  onCancel,
}: {
  tone?: FeedbackTone;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  isWorking?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const style = toneStyles[tone];

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={title}
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.85rem",
        alignItems: "center",
        padding: "1rem",
        marginBottom: "1rem",
        borderRadius: "8px",
        border: `1px solid ${style.border}`,
        background: style.bg,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "8px",
          display: "grid",
          placeItems: "center",
          background: style.soft,
          color: style.color,
        }}
      >
        <ToneIcon tone={tone} size={19} />
      </div>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ fontWeight: 800, color: "var(--text-main)", marginBottom: "0.2rem" }}>{title}</div>
        <div style={{ color: "var(--text-secondary)", fontSize: "0.86rem", lineHeight: 1.5 }}>{message}</div>
      </div>
      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap", marginLeft: "auto" }}>
        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={isWorking}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="btn"
          onClick={onConfirm}
          disabled={isWorking}
          style={{ background: tone === "danger" ? "var(--danger)" : style.color, minWidth: 96 }}
        >
          {isWorking ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : confirmLabel}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "4rem 1.5rem",
        textAlign: "center",
        color: "var(--text-muted)",
        display: "grid",
        justifyItems: "center",
        gap: "0.75rem",
      }}
    >
      <div style={{ opacity: 0.28, color: "var(--text-muted)", display: "flex" }}>{icon}</div>
      <div style={{ color: "var(--text-main)", fontWeight: 800 }}>{title}</div>
      {description && <div style={{ maxWidth: 420, fontSize: "0.9rem", lineHeight: 1.55 }}>{description}</div>}
      {action && <div style={{ marginTop: "0.35rem" }}>{action}</div>}
    </div>
  );
}

export function LoadingRows({ columns = 6, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div style={{ padding: "1rem" }} aria-busy="true">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, minmax(64px, 1fr))`,
          gap: "1rem",
          marginBottom: "1rem",
          padding: "1rem",
          background: "var(--surface-hover)",
          borderRadius: "6px",
        }}
      >
        {Array.from({ length: columns }, (_, index) => (
          <div key={index} className="skeleton-loader" style={{ height: 20 }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          style={{
            display: "grid",
            gridTemplateColumns: "48px 100px 150px minmax(120px, 1fr) 100px",
            gap: "1rem",
            padding: "1.5rem 1rem",
            borderBottom: "1px solid var(--surface-border)",
          }}
        >
          {Array.from({ length: 5 }, (_, colIndex) => (
            <div key={colIndex} className="skeleton-loader" style={{ height: 20 }} />
          ))}
        </div>
      ))}
    </div>
  );
}
