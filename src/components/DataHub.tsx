"use client";

import { useState, useRef, useMemo } from "react";
import {
  Upload,
  Download,
  FileText,
  X,
  Check,
  FileUp,
  Loader2,
  AlertTriangle,
  Search,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  FileJson,
  Layers,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import {
  toCsvDocument,
  parseImportContent,
  generateCsvTemplate,
  generateJsonTemplate,
  type ParsedImportFile,
  type NormalizedImportRecord,
} from "@/lib/csv";
import { OperationNotice, type FeedbackTone } from "@/components/OperationFeedback";
import "./datahub.css";

interface SubscriberExportRow {
  imsi?: string;
  status?: string;
  plmn?: string;
  policy?: string;
  policyName?: string;
  policyStatus?: string;
  traffic?: { used?: number; total?: number; balance?: number };
  sms?: { used?: number; total?: number; balance?: number };
  lastActive?: string;
  [key: string]: unknown;
}

interface DataHubProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  onOperation?: (feedback: { tone: FeedbackTone; title: string; message: string }) => void;
  subscribers?: SubscriberExportRow[];
  selectedImsis?: string[];
}

type ImportStage = "upload" | "precheck" | "confirm" | "importing" | "done";
type ExportFormat = "csv" | "json";
type ConflictFilterTab = "all" | "new" | "conflicts" | "invalid";

interface ConflictInfo {
  imsi: string;
  exists: boolean;
}

const EXPORT_FIELDS = [
  { key: "imsi", labelKey: "dh_field_imsi", header: "IMSI", getValue: (s: SubscriberExportRow) => s.imsi || "" },
  { key: "status", labelKey: "dh_field_status", header: "Status", getValue: (s: SubscriberExportRow) => s.status || "" },
  { key: "plmn", labelKey: "dh_field_plmn", header: "PLMN", getValue: (s: SubscriberExportRow) => s.plmn || "" },
  { key: "policy", labelKey: "dh_field_policy", header: "Plan_ID", getValue: (s: SubscriberExportRow) => s.policy || "" },
  { key: "policy_name", labelKey: "dh_field_policy_name", header: "Plan_Name", getValue: (s: SubscriberExportRow) => s.policyName || s.policy || "" },
  { key: "policy_status", labelKey: "dh_field_policy_status", header: "Plan_Status", getValue: (s: SubscriberExportRow) => s.policyStatus || "" },
  { key: "traffic_used", labelKey: "dh_field_traffic_used", header: "Traffic_Used_Bytes", getValue: (s: SubscriberExportRow) => s.traffic?.used || 0 },
  { key: "traffic_total", labelKey: "dh_field_traffic_total", header: "Traffic_Total_Bytes", getValue: (s: SubscriberExportRow) => s.traffic?.total || 0 },
  { key: "sms_used", labelKey: "dh_field_sms_used", header: "SMS_Used_Events", getValue: (s: SubscriberExportRow) => s.sms?.used || 0 },
  { key: "sms_total", labelKey: "dh_field_sms_total", header: "SMS_Total_Events", getValue: (s: SubscriberExportRow) => s.sms?.total || 0 },
  { key: "sms_balance", labelKey: "dh_field_sms_balance", header: "SMS_Balance_Events", getValue: (s: SubscriberExportRow) => s.sms?.balance || 0 },
  { key: "last_active", labelKey: "dh_field_last_active", header: "Last_Updated", getValue: (s: SubscriberExportRow) => s.lastActive || "" },
] as const;

const PRESET_CORE = ["imsi", "status", "plmn", "policy", "traffic_used", "traffic_total"];
const PRESET_BILLING = ["imsi", "policy", "policy_name", "traffic_total", "sms_total", "sms_balance"];

export default function DataHub({
  isOpen,
  onClose,
  onComplete,
  onOperation,
  subscribers = [],
  selectedImsis = [],
}: DataHubProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"import" | "export">("export");
  const [importStage, setImportStage] = useState<ImportStage>("upload");
  const [parsedFile, setParsedFile] = useState<ParsedImportFile | null>(null);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [conflictFilter, setConflictFilter] = useState<ConflictFilterTab>("all");
  const [previewSearch, setPreviewSearch] = useState("");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Export Settings
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [exportScope, setExportScope] = useState<"selected" | "filtered">(() =>
    selectedImsis.length > 0 ? "selected" : "filtered"
  );
  const [selectedExportFields, setSelectedExportFields] = useState<string[]>(() =>
    EXPORT_FIELDS.map((f) => f.key)
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Calculate scope counts
  const selectedCount = selectedImsis.length;
  const filteredCount = subscribers.length;

  // ========== Export Handlers ==========
  const handleExport = () => {
    if (filteredCount === 0 || selectedExportFields.length === 0) return;

    const dataToExport =
      exportScope === "selected" && selectedCount > 0
        ? subscribers.filter((s) => selectedImsis.includes(s.imsi || ""))
        : subscribers;

    if (dataToExport.length === 0) {
      setError(t("dh_err_empty"));
      return;
    }

    const activeFields = EXPORT_FIELDS.filter((field) =>
      selectedExportFields.includes(field.key)
    );
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const basename = `xcloud_subscribers_${timestamp}`;
    let blob: Blob;
    let filename: string;

    if (exportFormat === "json") {
      const payload = dataToExport.map((subscriber) => {
        const row: Record<string, unknown> = {};
        activeFields.forEach((field) => {
          row[field.header] = field.getValue(subscriber);
        });
        return row;
      });
      blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json;charset=utf-8;",
      });
      filename = `${basename}.json`;
    } else {
      const headers = activeFields.map((f) => f.header);
      const rows = dataToExport.map((sub) =>
        activeFields.map((f) => f.getValue(sub))
      );
      const content = toCsvDocument(headers, rows, true);
      blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
      filename = `${basename}.csv`;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);

    onOperation?.({
      tone: "success",
      title: t("success"),
      message: `${t(exportFormat === "json" ? "dh_btn_download_json" : "dh_btn_download_csv")} (${dataToExport.length})`,
    });
  };

  const applyPreset = (preset: "all" | "core" | "billing" | "clear") => {
    switch (preset) {
      case "all":
        setSelectedExportFields(EXPORT_FIELDS.map((f) => f.key));
        break;
      case "core":
        setSelectedExportFields(PRESET_CORE);
        break;
      case "billing":
        setSelectedExportFields(PRESET_BILLING);
        break;
      case "clear":
        setSelectedExportFields([]);
        break;
    }
  };

  const toggleExportField = (fieldKey: string) => {
    setSelectedExportFields((current) =>
      current.includes(fieldKey)
        ? current.filter((key) => key !== fieldKey)
        : [...current, fieldKey]
    );
  };

  // ========== Template Downloads ==========
  const downloadTemplate = (format: "csv" | "json") => {
    let content: string;
    let filename: string;
    let type: string;

    if (format === "json") {
      content = generateJsonTemplate();
      filename = "subscriber_import_template.json";
      type = "application/json;charset=utf-8;";
    } else {
      content = generateCsvTemplate();
      filename = "subscriber_import_template.csv";
      type = "text/csv;charset=utf-8;";
    }

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ========== File Processing & Pre-check ==========
  const processUploadedFile = (file: File) => {
    setError(null);
    const reader = new FileReader();

    reader.onload = async (event) => {
      try {
        const text = String(event.target?.result || "");
        const parsed = parseImportContent(text);

        if (parsed.records.length === 0) {
          setError(t("dh_err_no_valid"));
          return;
        }

        setParsedFile(parsed);
        await runPrecheck(parsed.records);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t("dh_err_parse");
        setError(msg);
      }
    };

    reader.readAsText(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processUploadedFile(file);
    }
  };

  const runPrecheck = async (records: NormalizedImportRecord[]) => {
    setImportStage("precheck");
    setIsProcessing(true);

    try {
      const imsiList = Array.from(new Set(records.map((r) => r.imsi)));
      const res = await fetch("/api/subscribers/import?mode=precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imsiList }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error || t("dh_err_precheck"));
        setImportStage("upload");
      } else {
        setConflicts(data.conflicts || []);
        setImportStage("confirm");
      }
    } catch {
      setError(t("dh_err_precheck"));
      setImportStage("upload");
    } finally {
      setIsProcessing(false);
    }
  };

  // ========== Execute Import ==========
  const executeImport = async () => {
    if (!parsedFile || parsedFile.records.length === 0) return;
    setImportStage("importing");
    setIsProcessing(true);
    setError(null);

    try {
      const res = await fetch("/api/subscribers/import?mode=import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          records: parsedFile.records,
          overwrite: overwriteExisting,
        }),
      });
      const data = await res.json();

      if (res.status === 202) {
        // Approval requested
        setImportResult(data);
        setImportStage("done");
      } else if (res.ok || res.status === 207) {
        setImportResult(data);
        setImportStage("done");
      } else {
        setError(
          data.error === "Tariff plan not found"
            ? t("tariff_plan_err_not_found")
            : data.error === "Invalid plan_id format"
            ? t("tariff_plan_err_id")
            : data.error === "Tariff plan is disabled"
            ? t("tariff_plan_err_disabled")
            : data.error || t("dh_err_import")
        );
        setImportStage("confirm");
      }
    } catch {
      setError(t("dh_err_import"));
      setImportStage("confirm");
    } finally {
      setIsProcessing(false);
    }
  };

  const resetImport = () => {
    setImportStage("upload");
    setParsedFile(null);
    setConflicts([]);
    setOverwriteExisting(false);
    setImportResult(null);
    setError(null);
    setPreviewSearch("");
    setConflictFilter("all");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Download error log
  const downloadErrorReport = () => {
    if (!parsedFile) return;
    const errorRows: Array<[number, string, string]> = parsedFile.errors.map(
      (err) => [err.row, err.imsi || "-", err.reason]
    );
    if (importResult?.failedImsis?.length) {
      importResult.failedImsis.forEach((imsi: string, idx: number) => {
        errorRows.push([idx + 1, imsi, "Database insertion failed"]);
      });
    }

    const headers = ["Row_Number", "IMSI", "Error_Reason"];
    const content = toCsvDocument(headers, errorRows, true);
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `import_errors_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Preview Filtered List calculation
  const conflictMap = useMemo(() => {
    const map = new Map<string, boolean>();
    conflicts.forEach((c) => map.set(c.imsi, c.exists));
    return map;
  }, [conflicts]);

  const previewRows = useMemo(() => {
    if (!parsedFile) return [];
    return parsedFile.allRecords.filter((item) => {
      const existsInDb = conflictMap.get(item.imsi) === true;
      const isInvalid = !item._valid;

      // Filter by tab
      if (conflictFilter === "new" && (existsInDb || isInvalid)) return false;
      if (conflictFilter === "conflicts" && !existsInDb) return false;
      if (conflictFilter === "invalid" && !isInvalid) return false;

      // Filter by search
      if (previewSearch.trim()) {
        const q = previewSearch.toLowerCase().trim();
        const matchesImsi = item.imsi.toLowerCase().includes(q);
        const matchesPlan = (item.plan_id || "").toLowerCase().includes(q);
        if (!matchesImsi && !matchesPlan) return false;
      }

      return true;
    });
  }, [parsedFile, conflictMap, conflictFilter, previewSearch]);

  const existingCount = conflicts.filter((c) => c.exists).length;
  const newCount = conflicts.filter((c) => !c.exists).length;
  const invalidCount = parsedFile?.invalidRows || 0;
  const totalRowsCount = parsedFile?.totalRows || 0;

  if (!isOpen) return null;

  return (
    <div className="dh-overlay" onClick={onClose}>
      <div className="dh-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="dh-header">
          <div className="dh-title-group">
            <div className="dh-icon-box">
              <Layers size={20} className="dh-header-icon" />
            </div>
            <div>
              <h3 className="dh-title">{t("dh_title")}</h3>
              <p className="dh-subtitle">
                {activeTab === "export" ? t("dh_export_title") : t("dh_tab_import")}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="dh-close-btn" aria-label={t("close")}>
            <X size={18} />
          </button>
        </div>

        {/* Tab Bar */}
        <div className="dh-tabs">
          <button
            type="button"
            onClick={() => setActiveTab("export")}
            className={`dh-tab ${activeTab === "export" ? "dh-tab-active" : "dh-tab-inactive"}`}
          >
            <Download size={16} />
            <span>{t("dh_tab_export")}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("import");
              if (importStage === "done") resetImport();
            }}
            className={`dh-tab ${activeTab === "import" ? "dh-tab-active" : "dh-tab-inactive"}`}
          >
            <Upload size={16} />
            <span>{t("dh_tab_import")}</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="dh-content">
          {/* ==================== EXPORT TAB ==================== */}
          {activeTab === "export" && (
            <div className="dh-export-view">
              {/* Scope & Format Row */}
              <div className="dh-section-card">
                <div className="dh-card-header">
                  <span className="dh-section-title">{t("dh_scope_title")}</span>
                  <div className="dh-pill-group">
                    {selectedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setExportScope("selected")}
                        className={`dh-pill-btn ${exportScope === "selected" ? "dh-pill-active" : ""}`}
                      >
                        {t("dh_scope_selected", { count: selectedCount })}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setExportScope("filtered")}
                      className={`dh-pill-btn ${exportScope === "filtered" ? "dh-pill-active" : ""}`}
                    >
                      {t("dh_scope_filtered", { count: filteredCount })}
                    </button>
                  </div>
                </div>

                <div className="dh-card-divider" />

                <div className="dh-export-format-row">
                  <div>
                    <div className="dh-export-format-label">{t("dh_export_format")}</div>
                    <div className="dh-export-format-sub">{t("dh_export_fields")}</div>
                  </div>
                  <div className="dh-format-group">
                    <button
                      type="button"
                      onClick={() => setExportFormat("csv")}
                      className={`dh-format-btn ${exportFormat === "csv" ? "dh-format-btn-active" : "dh-format-btn-inactive"}`}
                    >
                      <FileSpreadsheet size={14} /> CSV (Excel)
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat("json")}
                      className={`dh-format-btn ${exportFormat === "json" ? "dh-format-btn-active" : "dh-format-btn-inactive"}`}
                    >
                      <FileJson size={14} /> JSON
                    </button>
                  </div>
                </div>
              </div>

              {/* Field Selection Options */}
              <div className="dh-section-card">
                <div className="dh-card-header">
                  <span className="dh-section-title">{t("dh_export_fields")}</span>
                  <div className="dh-presets-row">
                    <button
                      type="button"
                      onClick={() => applyPreset("all")}
                      className="dh-preset-link"
                    >
                      {t("dh_preset_all")}
                    </button>
                    <span className="dh-preset-sep">|</span>
                    <button
                      type="button"
                      onClick={() => applyPreset("core")}
                      className="dh-preset-link"
                    >
                      {t("dh_preset_core")}
                    </button>
                    <span className="dh-preset-sep">|</span>
                    <button
                      type="button"
                      onClick={() => applyPreset("billing")}
                      className="dh-preset-link"
                    >
                      {t("dh_preset_billing")}
                    </button>
                    <span className="dh-preset-sep">|</span>
                    <button
                      type="button"
                      onClick={() => applyPreset("clear")}
                      className="dh-preset-link dh-preset-clear"
                    >
                      {t("dh_clear_all")}
                    </button>
                  </div>
                </div>

                <div className="dh-fields-grid">
                  {EXPORT_FIELDS.map((field) => {
                    const checked = selectedExportFields.includes(field.key);
                    return (
                      <label
                        key={field.key}
                        className={`dh-field-label ${checked ? "dh-field-label-active" : "dh-field-label-inactive"}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleExportField(field.key)}
                          className="checkbox-custom"
                        />
                        <span className="dh-field-text">{t(field.labelKey)}</span>
                        <code className="dh-field-code">{field.header}</code>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Download Action Footer */}
              <div className="dh-footer-actions">
                <button
                  type="button"
                  onClick={onClose}
                  className="dh-btn-secondary"
                >
                  {t("dh_btn_cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleExport();
                    onClose();
                  }}
                  disabled={
                    filteredCount === 0 || selectedExportFields.length === 0
                  }
                  className="btn dh-download-btn"
                >
                  <Download size={16} />
                  <span>
                    {t(
                      exportFormat === "json"
                        ? "dh_btn_download_json"
                        : "dh_btn_download_csv"
                    )}
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* ==================== IMPORT TAB ==================== */}
          {activeTab === "import" && (
            <div className="dh-import-view">
              {error && (
                <OperationNotice
                  presentation="inline"
                  tone="danger"
                  title={t("error")}
                  message={error}
                  onClose={() => setError(null)}
                />
              )}

              {/* Stage: Upload */}
              {importStage === "upload" && (
                <div className="dh-upload-stage">
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`dh-upload-area ${isDragging ? "dh-upload-area-drag" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) {
                        processUploadedFile(file);
                      }
                    }}
                  >
                    <div className="dh-upload-icon-circle">
                      <FileUp size={36} className="dh-upload-icon" />
                    </div>
                    <p className="dh-upload-title">{t("dh_upload_drag")}</p>
                    <p className="dh-upload-desc">{t("dh_upload_desc")}</p>

                    <div className="dh-upload-badges">
                      <span className="dh-file-badge">.CSV</span>
                      <span className="dh-file-badge">.JSON</span>
                    </div>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    onChange={handleFileInputChange}
                    className="dh-file-input"
                  />

                  {/* Standard Templates Section */}
                  <div className="dh-templates-bar">
                    <div className="dh-template-info">
                      <FileText size={16} className="dh-template-icon" />
                      <span>{t("dh_template_options")}</span>
                    </div>
                    <div className="dh-template-actions">
                      <button
                        type="button"
                        onClick={() => downloadTemplate("csv")}
                        className="dh-template-btn"
                      >
                        <Download size={14} /> CSV Template
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadTemplate("json")}
                        className="dh-template-btn"
                      >
                        <Download size={14} /> JSON Template
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Stage: Precheck Loading */}
              {importStage === "precheck" && (
                <div className="dh-loading-view">
                  <div className="dh-spinner-wrap">
                    <Loader2 size={38} className="dh-spinner" />
                  </div>
                  <h4 className="dh-loading-title">{t("dh_precheck_running")}</h4>
                  <p className="dh-loading-text">{t("dh_stat_total")}: {parsedFile?.totalRows || 0}</p>
                </div>
              )}

              {/* Stage: Confirm & Preview Matrix */}
              {importStage === "confirm" && parsedFile && (
                <div className="dh-confirm-stage">
                  {/* Summary Metric Cards */}
                  <div className="dh-stats-grid">
                    <div className="dh-stat-box dh-stat-new">
                      <div className="dh-stat-val">{newCount}</div>
                      <div className="dh-stat-label">{t("dh_stat_new")}</div>
                    </div>
                    <div className="dh-stat-box dh-stat-conflict">
                      <div className="dh-stat-val">{existingCount}</div>
                      <div className="dh-stat-label">{t("dh_stat_conflict")}</div>
                    </div>
                    {invalidCount > 0 && (
                      <div className="dh-stat-box dh-stat-invalid">
                        <div className="dh-stat-val">{invalidCount}</div>
                        <div className="dh-stat-label">{t("dh_stat_invalid")}</div>
                      </div>
                    )}
                    <div className="dh-stat-box dh-stat-total">
                      <div className="dh-stat-val">{totalRowsCount}</div>
                      <div className="dh-stat-label">{t("dh_stat_total")}</div>
                    </div>
                  </div>

                  {/* Conflict Strategy Option */}
                  {existingCount > 0 && (
                    <div className="dh-strategy-card">
                      <div className="dh-strategy-header">
                        <AlertTriangle size={18} className="dh-strategy-icon" />
                        <div>
                          <div className="dh-strategy-title">
                            {overwriteExisting ? t("dh_strategy_overwrite") : t("dh_strategy_skip")}
                          </div>
                          <div className="dh-strategy-desc">
                            {t("dh_overwrite_desc", { count: existingCount })}
                          </div>
                        </div>
                      </div>
                      <label className="dh-strategy-toggle">
                        <input
                          type="checkbox"
                          checked={overwriteExisting}
                          onChange={(e) => setOverwriteExisting(e.target.checked)}
                          className="checkbox-custom"
                        />
                        <span>{t("dh_overwrite")}</span>
                      </label>
                    </div>
                  )}

                  {/* Preview Filters & Search */}
                  <div className="dh-preview-controls">
                    <div className="dh-filter-tabs">
                      <button
                        type="button"
                        onClick={() => setConflictFilter("all")}
                        className={`dh-filter-btn ${conflictFilter === "all" ? "dh-filter-btn-active" : ""}`}
                      >
                        {t("dh_filter_all")} ({totalRowsCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => setConflictFilter("new")}
                        className={`dh-filter-btn ${conflictFilter === "new" ? "dh-filter-btn-active" : ""}`}
                      >
                        {t("dh_filter_new")} ({newCount})
                      </button>
                      {existingCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setConflictFilter("conflicts")}
                          className={`dh-filter-btn ${conflictFilter === "conflicts" ? "dh-filter-btn-active" : ""}`}
                        >
                          {t("dh_filter_conflicts")} ({existingCount})
                        </button>
                      )}
                      {invalidCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setConflictFilter("invalid")}
                          className={`dh-filter-btn dh-filter-btn-err ${conflictFilter === "invalid" ? "dh-filter-btn-active" : ""}`}
                        >
                          {t("dh_filter_invalid")} ({invalidCount})
                        </button>
                      )}
                    </div>

                    <div className="dh-search-wrap">
                      <Search size={14} className="dh-search-icon" />
                      <input
                        type="text"
                        placeholder={t("dh_search_placeholder")}
                        value={previewSearch}
                        onChange={(e) => setPreviewSearch(e.target.value)}
                        className="dh-search-input"
                      />
                    </div>
                  </div>

                  {/* Conflict Preview Table */}
                  <div className="dh-table-wrap">
                    <table className="dh-table">
                      <caption className="sr-only">{t("dh_tab_import")}</caption>
                      <thead>
                        <tr className="dh-table-tr-head">
                          <th className="dh-table-th">#</th>
                          <th className="dh-table-th">{t("dh_col_imsi")}</th>
                          <th className="dh-table-th">{t("sub_360_tariff_plan")}</th>
                          <th className="dh-table-th">{t("sub_traffic_balance")}</th>
                          <th className="dh-table-th">{t("prof_sms_balance")}</th>
                          <th className="dh-table-th-center">{t("dh_col_status")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="dh-table-empty">
                              {t("no_subscribers_search")}
                            </td>
                          </tr>
                        ) : (
                          previewRows.map((row) => {
                            const existsInDb = conflictMap.get(row.imsi) === true;
                            const isDuplicate = row._duplicate;
                            const isInvalid = !row._valid;

                            return (
                              <tr key={`${row._row}-${row.imsi}`} className="dh-table-tr">
                                <td className="dh-table-td-num">{row._row}</td>
                                <td className="dh-table-td-imsi">
                                  <span>{row.imsi || "(empty)"}</span>
                                  {isInvalid && row._error && (
                                    <span className="dh-row-error" title={row._error}>
                                      <AlertCircle size={12} /> {row._error}
                                    </span>
                                  )}
                                </td>
                                <td className="dh-table-td">{row.plan_id || "plan_default_10gb"}</td>
                                <td className="dh-table-td">{row.traffic_balance || "-"}</td>
                                <td className="dh-table-td">{row.sms_balance || "-"}</td>
                                <td className="dh-table-td-center">
                                  {isDuplicate ? (
                                    <span className="dh-badge dh-badge-duplicate">
                                      {t("dh_badge_duplicate")}
                                    </span>
                                  ) : isInvalid ? (
                                    <span className="dh-badge dh-badge-invalid">
                                      {t("dh_badge_invalid")}
                                    </span>
                                  ) : existsInDb ? (
                                    <span className="dh-badge dh-badge-conflict">
                                      {t("dh_badge_exists")}
                                    </span>
                                  ) : (
                                    <span className="dh-badge dh-badge-new">
                                      {t("dh_badge_new")}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Actions Footer */}
                  <div className="dh-footer-actions">
                    <button
                      type="button"
                      onClick={resetImport}
                      className="dh-btn-secondary"
                    >
                      {t("dh_btn_cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={executeImport}
                      disabled={
                        isProcessing ||
                        (overwriteExisting
                          ? parsedFile.validRows === 0
                          : newCount === 0)
                      }
                      className="btn dh-btn-import"
                    >
                      <Upload size={16} />
                      <span>
                        {t("dh_btn_import", {
                          count: overwriteExisting
                            ? parsedFile.validRows
                            : newCount,
                        })}
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* Stage: Importing */}
              {importStage === "importing" && (
                <div className="dh-loading-view">
                  <div className="dh-spinner-wrap">
                    <Loader2 size={38} className="dh-spinner" />
                  </div>
                  <h4 className="dh-loading-title">{t("dh_importing")}</h4>
                  <div className="dh-progress-bar-bg">
                    <div className="dh-progress-bar-fill" />
                  </div>
                </div>
              )}

              {/* Stage: Done */}
              {importStage === "done" && importResult && (
                <div className="dh-done-view">
                  <div className="dh-done-icon-wrap">
                    <CheckCircle2 size={36} className="dh-done-icon" />
                  </div>
                  <h4 className="dh-done-title">
                    {importResult.approval?.id
                      ? t("approval_status_pending")
                      : t("dh_import_complete")}
                  </h4>
                  <p className="dh-done-desc">
                    {importResult.approval?.id
                      ? t("approval_msg_submitted", { id: importResult.approval.id })
                      : t("dh_import_summary", {
                          imported: importResult.imported ?? 0,
                          skipped: importResult.skipped ?? 0,
                        })}
                  </p>

                  {importResult.failed > 0 && (
                    <div className="dh-error-warning-box">
                      <AlertTriangle size={16} />
                      <span>{importResult.failed} record(s) failed database validation.</span>
                      <button
                        type="button"
                        onClick={downloadErrorReport}
                        className="dh-error-report-btn"
                      >
                        <Download size={13} /> {t("dh_download_error_report")}
                      </button>
                    </div>
                  )}

                  <div className="dh-done-actions">
                    <button
                      type="button"
                      onClick={resetImport}
                      className="dh-btn-secondary"
                    >
                      {t("dh_import_another")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!importResult.approval?.id) onComplete();
                        onClose();
                      }}
                      className="btn dh-btn-done"
                    >
                      <Check size={16} /> {t("dh_btn_done")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
