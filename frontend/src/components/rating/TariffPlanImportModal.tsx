"use client";
import React, { useRef, useState } from "react";
import { Upload, FileCode, CheckCircle2, AlertTriangle, AlertCircle, X } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { Field } from "@/components/ui/Field";
import { ErrorNotice, InlineNotice } from "@/components/ui/InlineNotice";
import { normalizeImportedPlan } from "@/lib/tariffPlanOperations";
import { Dialog } from "@/components/ui/Dialog";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (importedPlanId: string) => void;
};

export function TariffPlanImportModal({ isOpen, onClose, onSuccess }: Props) {
  const { t } = useI18n();
  const [jsonText, setJsonText] = useState("");
  const [parsedPreview, setParsedPreview] = useState<any>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  if (!isOpen) return null;

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    setApiError(null);
    if (!text.trim()) {
      setParsedPreview(null);
      setValidationErrors([]);
      setValidationWarnings([]);
      return;
    }

    try {
      const obj = JSON.parse(text);
      const res = normalizeImportedPlan(obj);
      setParsedPreview(res.plan);
      setValidationErrors(res.errors);
      setValidationWarnings(res.warnings);
    } catch {
      setParsedPreview(null);
      setValidationErrors(["Invalid JSON format"]);
      setValidationWarnings([]);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      handleJsonChange(content);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!parsedPreview || validationErrors.length > 0) return;
    setLoading(true);
    setApiError(null);

    try {
      const res = await fetch("/api/tariff-plans/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedPreview),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || (data.details ? data.details.join("; ") : "Import failed"));
      }

      onSuccess(data.plan?.plan_id || parsedPreview.plan_id);
      onClose();
    } catch (err: any) {
      setApiError(err.message || "Failed to import tariff plan");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={() => { if (!loading) onClose(); }}
      overlayClassName="modal-overlay animate-fade-in"
      className="modal-content modal-content-wide"
      overlayStyle={{ zIndex: 1050 }}
      labelledBy="tariff-plan-import-modal-title"
      initialFocusRef={cancelButtonRef}
      closeOnOverlay={!loading}
    >
        <div className="modal-header">
          <div className="flex-center-gap-0-55">
            <Upload size={20} color="var(--primary)" />
            <h2 id="tariff-plan-import-modal-title" className="modal-title">{t("tariff_plan_import_title")}</h2>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} disabled={loading} aria-label={t("close")}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body grid-gap-1">
          <p className="card-desc card-desc-flush">
            {t("tariff_plan_import_desc")}
          </p>

          <div>
            <label className="btn btn-outline rating-import-file-btn">
              <FileCode size={16} className="rating-import-file-icon" />
              {t("tariff_plan_import_file")}
              <input type="file" accept=".json" onChange={handleFileUpload} className="rating-import-file-input" />
            </label>
          </div>

          <Field label={t("tariff_plan_import_paste")}>
            <textarea
              className="form-input rating-import-textarea"
              value={jsonText}
              onChange={(e) => handleJsonChange(e.target.value)}
              placeholder='{\n  "plan_id": "plan_enterprise_unlimited",\n  "name": "Enterprise Unlimited",\n  "rules": [...]\n}'
              disabled={loading}
            />
          </Field>

          {apiError && (
            <ErrorNotice icon={<AlertCircle size={16} />}>{apiError}</ErrorNotice>
          )}

          {validationErrors.length > 0 && (
            <ErrorNotice icon={<AlertCircle size={15} />}>
              <strong>Validation Errors:</strong>
              <ul className="rating-notice-list">
                {validationErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </ErrorNotice>
          )}

          {validationWarnings.length > 0 && (
            <InlineNotice tone="warning" icon={<AlertTriangle size={15} />}>
              <strong>Warnings:</strong>
              <ul className="rating-notice-list">
                {validationWarnings.map((warn, i) => (
                  <li key={i}>{warn}</li>
                ))}
              </ul>
            </InlineNotice>
          )}

          {parsedPreview && validationErrors.length === 0 && (
            <div className="stat-card stat-card-preview">
              <div className="rating-preview-ready">
                <CheckCircle2 size={16} /> Ready to Import
              </div>
              <div className="rating-preview-grid">
                <div><strong>Plan ID:</strong> {parsedPreview.plan_id}</div>
                <div><strong>Name:</strong> {parsedPreview.name || parsedPreview.plan_id}</div>
                <div><strong>Rules:</strong> {parsedPreview.rules?.length || 0} rules included</div>
                <div><strong>Status:</strong> {parsedPreview.status || "active"}</div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button ref={cancelButtonRef} type="button" className="btn btn-outline" onClick={onClose} disabled={loading}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleImport}
            disabled={loading || !parsedPreview || validationErrors.length > 0}
          >
            <Upload size={15} /> {loading ? t("saving") : t("tariff_plan_import_btn")}
          </button>
        </div>
    </Dialog>
  );
}
