"use client";

import { useId, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { Dialog } from "@/components/ui/Dialog";

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
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
    <Dialog
      open={Boolean(data)}
      onClose={onClose}
      overlayClassName="ocs-drawer-backdrop"
      className="ocs-drawer-content"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={closeButtonRef}
    >
        <div className="ocs-drawer-header">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <h2 id={titleId} className="ocs-drawer-title">{title}</h2>
            <span id={descriptionId} style={{ fontSize: "var(--ref-font-size-label)", color: "var(--text-muted)" }}>
              {t("ocs_modal_detail_title")}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              ref={closeButtonRef}
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
    </Dialog>
  );
}
