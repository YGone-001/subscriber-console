"use client";

import { useState, useRef } from "react";
import { Upload, Download, FileText, X, Check, FileUp, Loader2 } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { parseCsv, toCsvRow } from "@/lib/csv";
import { OperationNotice, type FeedbackTone } from "@/components/OperationFeedback";
import "./datahub.css";

/**
 * DataHub -- CSV Import/Export Hub
 * ---------------------------------------------------------
 * 鏁版嵁鏋㈢航缁勪欢, 鎻愪緵浠ヤ笅鍔熻兘:
 *
 * 1. CSV 瀵煎嚭: 灏嗗綋鍓嶈繃婊?閫変腑鐨勮闃呰€呭垪琛ㄥ鍑轰负鏍囧噯 CSV 鏂囦欢
 * 2. CSV 瀵煎叆:
 *    a. 妯℃澘涓嬭浇 (鎻愪緵鏍囧噯 CSV 妯℃澘)
 *    b. 鏂囦欢涓婁紶 + 瀹㈡埛绔В鏋?(FileReader API)
 *    c. 棰勬鍐茬獊妫€娴?(/api/subscribers/import?mode=precheck)
 *    d. 鍐茬獊纭鍚庢墽琛屽鍏?(/api/subscribers/import?mode=import)
 *
 * 瑙ｆ瀽娴佺▼:
 *   鐢ㄦ埛閫夋枃浠?-> 瀹㈡埛绔?CSV 瑙ｆ瀽 -> 鍙发閫?IMSI 鍒楄〃棰勬
 *   -> 灞曠ず鍐茬獊琛ㄦ牸 -> 鐢ㄦ埛纭璺宠繃/瑕嗙洊 -> 鎵ц瀵煎叆
 * ---------------------------------------------------------
 */

// CSV import only seeds HSS subscriber data and current OCS balance fields.
const CSV_TEMPLATE_HEADER = "imsi,k,opc,amf,plan_id,traffic_total,traffic_balance,sms_total,sms_balance,access_restriction_data";
const CSV_TEMPLATE_EXAMPLE = "454001234567890,00112233445566778899aabbccddeeff,00112233445566778899aabbccddeeff,8000,plan_default_10gb,10737418240,10737418240,100,100,32";

interface DataHubProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  onOperation?: (feedback: { tone: FeedbackTone; title: string; message: string }) => void;
  subscribers?: any[];
  selectedImsis?: string[];
}

type ImportStage = "upload" | "precheck" | "confirm" | "importing" | "done";
type ExportFormat = "csv" | "json";

interface ParsedRecord {
  imsi: string;
  k: string;
  opc: string;
  amf: string;
  plan_id: string;
  traffic_total: string;
  traffic_balance: string;
  sms_total: string;
  sms_balance: string;
  access_restriction_data: string;
  [key: string]: string;
}

interface ConflictInfo {
  imsi: string;
  exists: boolean;
}

const EXPORT_FIELDS = [
  { key: "imsi", labelKey: "dh_field_imsi", header: "IMSI", getValue: (s: any) => s.imsi || "" },
  { key: "status", labelKey: "dh_field_status", header: "Status", getValue: (s: any) => s.status || "" },
  { key: "plmn", labelKey: "dh_field_plmn", header: "PLMN", getValue: (s: any) => s.plmn || "" },
  { key: "policy", labelKey: "dh_field_policy", header: "Plan_ID", getValue: (s: any) => s.policy || "" },
  { key: "policy_name", labelKey: "dh_field_policy_name", header: "Plan_Name", getValue: (s: any) => s.policyName || s.policy || "" },
  { key: "policy_status", labelKey: "dh_field_policy_status", header: "Plan_Status", getValue: (s: any) => s.policyStatus || "" },
  { key: "traffic_used", labelKey: "dh_field_traffic_used", header: "Traffic_Used_Bytes", getValue: (s: any) => s.traffic?.used || 0 },
  { key: "traffic_total", labelKey: "dh_field_traffic_total", header: "Traffic_Total_Bytes", getValue: (s: any) => s.traffic?.total || 0 },
  { key: "sms_used", labelKey: "dh_field_sms_used", header: "SMS_Used_Events", getValue: (s: any) => s.sms?.used || 0 },
  { key: "sms_total", labelKey: "dh_field_sms_total", header: "SMS_Total_Events", getValue: (s: any) => s.sms?.total || 0 },
  { key: "sms_balance", labelKey: "dh_field_sms_balance", header: "SMS_Balance_Events", getValue: (s: any) => s.sms?.balance || 0 },
  { key: "last_active", labelKey: "dh_field_last_active", header: "Last_Updated", getValue: (s: any) => s.lastActive || "" },
] as const;

export default function DataHub({ isOpen, onClose, onComplete, onOperation, subscribers, selectedImsis }: DataHubProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"import" | "export">("export");
  const [importStage, setImportStage] = useState<ImportStage>("upload");
  const [parsedRecords, setParsedRecords] = useState<ParsedRecord[]>([]);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setIsProcessing] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [selectedExportFields, setSelectedExportFields] = useState<string[]>(() => EXPORT_FIELDS.map(field => field.key));
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // ========== CSV 瀵煎嚭閫昏緫 ==========

  /**
   * 鏍规嵁褰撳墠閫変腑鎴栧叏閮ㄨ闃呰€呯敓鎴?CSV 骞惰Е鍙戜笅杞?   * 瀵煎嚭瀛楁: IMSI, Status, PLMN, Policy, Traffic Used, Traffic Total
   */
  const handleExport = () => {
    if (!subscribers || subscribers.length === 0) return;
    if (selectedExportFields.length === 0) return;

    // 濡傛灉鏈夐€変腑鐨?IMSI, 鍙鍑洪€変腑鐨? 鍚﹀垯瀵煎嚭鍏ㄩ儴
    const dataToExport = selectedImsis && selectedImsis.length > 0
      ? subscribers.filter(s => selectedImsis.includes(s.imsi))
      : subscribers;

    const fields = EXPORT_FIELDS.filter(field => selectedExportFields.includes(field.key));
    const basename = `xcloud_subscribers_${new Date().toISOString().slice(0, 10)}`;
    let blob: Blob;
    let filename: string;

    if (exportFormat === "json") {
      const payload = dataToExport.map((subscriber) => {
        const row: Record<string, string | number> = {};
        fields.forEach((field) => {
          row[field.header] = field.getValue(subscriber);
        });
        return row;
      });
      blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8;" });
      filename = `${basename}.json`;
    } else {
      const header = toCsvRow(fields.map(field => field.header));
      const rows = dataToExport.map(subscriber => toCsvRow(fields.map(field => field.getValue(subscriber))));
      blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8;" });
      filename = `${basename}.csv`;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    onOperation?.({ tone: "success", title: t("success"), message: t(exportFormat === "json" ? "dh_btn_download_json" : "dh_btn_download_csv") });
  };

  const toggleExportField = (fieldKey: string) => {
    setSelectedExportFields((current) =>
      current.includes(fieldKey)
        ? current.filter((key) => key !== fieldKey)
        : [...current, fieldKey]
    );
  };

  const setAllExportFields = (checked: boolean) => {
    setSelectedExportFields(checked ? EXPORT_FIELDS.map(field => field.key) : []);
  };

  // ========== CSV 妯℃澘涓嬭浇 ==========
  const downloadTemplate = () => {
    const content = [CSV_TEMPLATE_HEADER, CSV_TEMPLATE_EXAMPLE].join("\n");
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xcloud_import_template.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  // ========== CSV 鏂囦欢瑙ｆ瀽 ==========

  /**
   * 瀹㈡埛绔?CSV 瑙ｆ瀽鍣?(鏃犲閮ㄤ緷璧?
   * 澶勭悊娴佺▼: FileReader 璇诲彇鏂囨湰 -> 鎸夎鍒嗗壊 -> 鎸夐€楀彿鎷嗚В -> 鏄犲皠涓哄璞℃暟缁?   * 娉ㄦ剰: 鏀寔鍙屽紩鍙峰寘瑁圭殑瀛楁 (鍚€楀彿)
   */
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const rows = parseCsv(text).filter(row => row.some(cell => cell.trim().length > 0));

        if (rows.length < 2) {
          setError(t("dh_err_empty"));
          return;
        }

        // 瑙ｆ瀽琛ㄥご
        const headers = rows[0].map(h => h.trim().toLowerCase());
        const imsiIdx = headers.indexOf("imsi");
        if (imsiIdx === -1) {
          setError(t("dh_err_no_imsi"));
          return;
        }

        // 閫愯瑙ｆ瀽鏁版嵁
        const records: ParsedRecord[] = [];
        for (let i = 1; i < rows.length; i++) {
          const values = rows[i];
          const record: any = {};
          headers.forEach((h, idx) => {
            record[h] = (values[idx] || "").trim();
          });

          // IMSI 鏍煎格式鏍￠獙: 蹇呴』涓?15 浣嶆暟瀛?
          if (!/^\d{15}$/.test(record.imsi)) continue;
          records.push(record as ParsedRecord);
        }

        if (records.length === 0) {
          setError(t("dh_err_no_valid"));
          return;
        }

        setParsedRecords(records);
        runPrecheck(records);
      } catch {
        setError(t("dh_err_parse"));
      }
    };

    reader.readAsText(file);
  };

  // ========== 棰勬鍐茬獊妫€娴?==========
  const runPrecheck = async (records: ParsedRecord[]) => {
    setImportStage("precheck");
    setIsProcessing(true);

    try {
      const res = await fetch("/api/subscribers/import?mode=precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imsiList: records.map(r => r.imsi) })
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error);
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

  // ========== 鎵ц瀵煎叆 ==========
  const executeImport = async () => {
    setImportStage("importing");
    setIsProcessing(true);

    try {
      const res = await fetch("/api/subscribers/import?mode=import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: parsedRecords, overwrite: overwriteExisting })
      });
      const data = await res.json();

      if (data.error) {
        setError(data.error === "Tariff plan not found"
          ? t("tariff_plan_err_not_found")
          : data.error === "Invalid plan_id format"
          ? t("tariff_plan_err_id")
          : data.error === "Tariff plan is disabled"
          ? t("tariff_plan_err_disabled")
          : data.error);
        setImportStage("confirm");
      } else {
        setImportResult(data);
        setImportStage("done");
      }
    } catch {
      setError(t("dh_err_import"));
      setImportStage("confirm");
    } finally {
      setIsProcessing(false);
    }
  };

  // 閲嶇疆瀵煎叆娴佺▼
  const resetImport = () => {
    setImportStage("upload");
    setParsedRecords([]);
    setConflicts([]);
    setOverwriteExisting(false);
    setImportResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const existingCount = conflicts.filter(c => c.exists).length;
  const newCount = conflicts.filter(c => !c.exists).length;

  return (
    <div className="dh-overlay" onClick={onClose}>
      <div className="dh-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="dh-header">
          <div className="dh-title-group">
            <FileText size={22} color="var(--primary)" />
            <h3 className="dh-title">{t("dh_title")}</h3>
          </div>
          <button onClick={onClose} className="dh-close-btn">
            <X size={20} />
          </button>
        </div>

        {/* Tab Bar */}
        <div className="dh-tabs">
          {[
            { key: "export" as const, label: t("dh_tab_export"), icon: Download },
            { key: "import" as const, label: t("dh_tab_import"), icon: Upload }
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); if (tab.key === "import") resetImport(); }}
              className={`dh-tab ${activeTab === tab.key ? 'dh-tab-active' : 'dh-tab-inactive'}`}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="dh-content">

          {/* ===== EXPORT TAB ===== */}
          {activeTab === "export" && (
            <div className="dh-export-view">
              <Download size={48} color="#4e73df" className="dh-export-icon" />
              <h4 className="dh-export-title">{t("dh_export_title")}</h4>
              <p className="dh-export-desc">
                {selectedImsis && selectedImsis.length > 0
                  ? t("dh_export_desc_selected").replace("{count}", selectedImsis.length.toString())
                  : t("dh_export_desc_all").replace("{count}", (subscribers?.length || 0).toString())
                }
              </p>
              <div className="dh-export-options">
                <div className="dh-export-format-row">
                  <div>
                    <div className="dh-export-format-label">{t("dh_export_format")}</div>
                    <div className="dh-export-format-sub">{t("dh_export_fields")}</div>
                  </div>
                  <div className="dh-format-group">
                    {(["csv", "json"] as ExportFormat[]).map((format) => (
                      <button
                        key={format}
                        type="button"
                        onClick={() => setExportFormat(format)}
                        className={`dh-format-btn ${exportFormat === format ? 'dh-format-btn-active' : 'dh-format-btn-inactive'}`}
                      >
                        {format}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="dh-export-actions">
                  <button type="button" onClick={() => setAllExportFields(true)} className="dh-select-btn dh-select-all">
                    {t("dh_select_all")}
                  </button>
                  <button type="button" onClick={() => setAllExportFields(false)} className="dh-select-btn dh-select-clear">
                    {t("dh_clear_all")}
                  </button>
                </div>

                <div className="dh-fields-grid">
                  {EXPORT_FIELDS.map((field) => {
                    const checked = selectedExportFields.includes(field.key);
                    return (
                      <label
                        key={field.key}
                        className={`dh-field-label ${checked ? 'dh-field-label-active' : 'dh-field-label-inactive'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleExportField(field.key)}
                          className="checkbox-custom"
                        />
                        {t(field.labelKey)}
                      </label>
                    );
                  })}
                </div>
              </div>
              <button
                onClick={() => { handleExport(); onClose(); }}
                disabled={!subscribers || subscribers.length === 0 || selectedExportFields.length === 0}
                className="btn dh-download-btn"
              >
                <Download size={18} /> {t(exportFormat === "json" ? "dh_btn_download_json" : "dh_btn_download_csv")}
              </button>
            </div>
          )}

          {/* ===== IMPORT TAB ===== */}
          {activeTab === "import" && (
            <div>
              {error && (
                <OperationNotice
                  presentation="modal"
                  tone="danger"
                  title={t("error")}
                  message={error}
                  onClose={() => setError(null)}
                />
              )}

              {/* Stage: Upload */}
              {importStage === "upload" && (
                <div>
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className="dh-upload-area"
                    onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = "#4e73df"; }}
                    onDragLeave={e => { e.currentTarget.style.borderColor = "#cbd5e1"; }}
                    onDrop={e => {
                      e.preventDefault();
                      e.currentTarget.style.borderColor = "#cbd5e1";
                      const file = e.dataTransfer.files[0];
                      if (file && fileInputRef.current) {
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        fileInputRef.current.files = dt.files;
                        fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
                      }
                    }}
                  >
                    <FileUp size={40} color="#94a3b8" className="dh-upload-icon" />
                    <p className="dh-upload-title">
                      {t("dh_upload_drag")}
                    </p>
                    <p className="dh-upload-desc">
                      {t("dh_upload_desc")}
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv"
                    onChange={handleFileUpload}
                    className="dh-file-input"
                  />
                  <div className="dh-template-wrap">
                    <button onClick={downloadTemplate} className="dh-template-btn">
                      <Download size={14} /> {t("dh_download_template")}
                    </button>
                  </div>
                </div>
              )}

              {/* Stage: Precheck Loading */}
              {importStage === "precheck" && (
                <div className="dh-loading-view">
                  <Loader2 size={32} color="var(--primary)" className="dh-spinner" />
                  <p className="dh-loading-text">{t("dh_precheck_running")}</p>
                </div>
              )}

              {/* Stage: Confirm */}
              {importStage === "confirm" && (
                <div>
                  <div className="dh-stats-grid">
                    <div className="dh-stat-box dh-stat-new">
                      <div className="dh-stat-new-val">{newCount}</div>
                      <div className="dh-stat-new-label">{t("dh_stat_new")}</div>
                    </div>
                    <div className="dh-stat-box dh-stat-conflict">
                      <div className="dh-stat-conflict-val">{existingCount}</div>
                      <div className="dh-stat-conflict-label">{t("dh_stat_conflict")}</div>
                    </div>
                    <div className="dh-stat-box dh-stat-total">
                      <div className="dh-stat-total-val">{parsedRecords.length}</div>
                      <div className="dh-stat-total-label">{t("dh_stat_total")}</div>
                    </div>
                  </div>

                  {existingCount > 0 && (
                    <div className="dh-overwrite-wrap">
                      <label className={`dh-overwrite-label ${overwriteExisting ? 'dh-overwrite-active' : 'dh-overwrite-inactive'}`}>
                        <input
                          type="checkbox"
                          checked={overwriteExisting}
                          onChange={e => setOverwriteExisting(e.target.checked)}
                          className="checkbox-custom"
                        />
                        <div>
                          <div className="dh-overwrite-title">{t("dh_overwrite")}</div>
                          <div className="dh-overwrite-desc">{t("dh_overwrite_desc").replace("{count}", existingCount.toString())}</div>
                        </div>
                      </label>
                    </div>
                  )}

                  {/* Conflict Preview Table */}
                  <div className="dh-table-wrap">
                    <table className="dh-table">
                      <thead>
                        <tr className="dh-table-tr-head">
                          <th className="dh-table-th">{t("dh_col_imsi")}</th>
                          <th className="dh-table-th">{t("sub_360_tariff_plan")}</th>
                          <th className="dh-table-th">{t("sub_traffic_balance")}</th>
                          <th className="dh-table-th">{t("prof_sms_balance")}</th>
                          <th className="dh-table-th-center">{t("dh_col_status")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {conflicts.map(c => (
                          <tr key={c.imsi} className="dh-table-tr">
                            <td className="dh-table-td-imsi">{c.imsi}</td>
                            <td className="dh-table-td">
                              {parsedRecords.find(r => r.imsi === c.imsi)?.plan_id || "plan_default_10gb"}
                            </td>
                            <td className="dh-table-td">
                              {parsedRecords.find(r => r.imsi === c.imsi)?.traffic_balance || "-"}
                            </td>
                            <td className="dh-table-td">
                              {parsedRecords.find(r => r.imsi === c.imsi)?.sms_balance || "-"}
                            </td>
                            <td className="dh-table-td-center">
                              <span className={`dh-badge ${c.exists ? 'dh-badge-conflict' : 'dh-badge-new'}`}>
                                {c.exists ? t("dh_badge_exists") : t("dh_badge_new")}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="dh-actions">
                    <button onClick={resetImport} className="dh-btn-cancel">
                      {t("dh_btn_cancel")}
                    </button>
                    <button onClick={executeImport} className="btn dh-btn-import">
                      <Upload size={16} />
                      {t("dh_btn_import").replace("{count}", (overwriteExisting ? parsedRecords.length : newCount).toString())}
                    </button>
                  </div>
                </div>
              )}

              {/* Stage: Importing */}
              {importStage === "importing" && (
                <div className="dh-loading-view">
                  <Loader2 size={32} color="var(--primary)" className="dh-spinner" />
                  <p className="dh-loading-text">{t("dh_importing")}</p>
                </div>
              )}

              {/* Stage: Done */}
              {importStage === "done" && importResult && (
                <div className="dh-done-view">
                  <div className="dh-done-icon-wrap">
                    <Check size={28} color="#16a34a" />
                  </div>
                  <h4 className="dh-done-title">{importResult.approval?.id ? t("approval_status_pending") : t("dh_import_complete")}</h4>
                  <p className="dh-done-desc">
                    {importResult.approval?.id
                      ? t("approval_msg_submitted", { id: importResult.approval.id })
                      : (
                        <>
                          {t("dh_import_summary")
                            .replace("{imported}", importResult.imported)
                            .replace("{skipped}", importResult.skipped)}
                          {importResult.failed > 0 ? `, ${importResult.failed} failed` : ""}
                        </>
                      )}
                  </p>
                  <button
                    onClick={() => { if (!importResult.approval?.id) onComplete(); onClose(); }}
                    className="btn dh-btn-done"
                  >
                    {t("dh_btn_done")}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
