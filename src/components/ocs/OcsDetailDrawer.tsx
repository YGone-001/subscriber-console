"use client";

import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

interface OcsDetailDrawerProps {
  title: string;
  data: Record<string, unknown> | null;
  onClose: () => void;
  fields?: Array<{ label: string; value: React.ReactNode }>;
}

export default function OcsDetailDrawer({
  title,
  data,
  onClose,
  fields,
}: OcsDetailDrawerProps) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

  if (!data) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy JSON:", e);
    }
  };

  return (
    <div className="ocs-drawer-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="ocs-drawer-content" onClick={(e) => e.stopPropagation()}>
        <div className="ocs-drawer-header">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <h3 className="ocs-drawer-title">{title}</h3>
            <span style={{ fontSize: "var(--ref-font-size-label)", color: "var(--text-muted)" }}>
              {t("ocs_modal_detail_title")}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              type="button"
              className="ocs-btn"
              onClick={handleCopy}
              title={t("ocs_modal_copy_json")}
            >
              {copied ? <Check size={14} color="var(--status-success)" /> : <Copy size={14} />}
              <span>{copied ? t("ocs_modal_copied") : t("ocs_modal_copy_json")}</span>
            </button>
            <button
              type="button"
              className="ocs-btn"
              onClick={onClose}
              aria-label={t("close")}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="ocs-drawer-body">
          {fields && fields.length > 0 ? (
            <div className="ocs-drawer-section">
              <span className="ocs-drawer-section-title">Structured Attributes</span>
              <div className="ocs-detail-grid">
                {fields.map((f, idx) => (
                  <div key={idx} className="ocs-detail-item">
                    <span className="ocs-detail-item-label">{f.label}</span>
                    <span className="ocs-detail-item-value ocs-mono">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="ocs-drawer-section">
            <span className="ocs-drawer-section-title">Raw JSON Payload</span>
            <pre className="ocs-json-view">{JSON.stringify(data, null, 2)}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
