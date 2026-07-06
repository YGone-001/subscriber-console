"use client";

import React, { useState } from 'react';
import { ShieldAlert, History, Activity, ChevronRight, Braces, X, Download, RefreshCw } from 'lucide-react';
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { toCsvRow } from "@/lib/csv";

interface AuditLog {
  id: string;
  timestamp: string;
  level: string;
  action: string;
  targetId: string;
  operatorIp: string;
  oldData: any;
  newData: any;
}

export default function AuditLogsPage() {
  const { t } = useI18n();
  const [inputAction, setInputAction] = useState('ALL');
  const [inputLevel, setInputLevel] = useState('ALL');
  const [inputImsi, setInputImsi] = useState('');
  const [inputProfile, setInputProfile] = useState('');
  const [inputOperator, setInputOperator] = useState('');
  const [inputKeyword, setInputKeyword] = useState('');
  const [inputFrom, setInputFrom] = useState('');
  const [inputTo, setInputTo] = useState('');
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');

  const [queryPayload, setQueryPayload] = useState({
    action: 'ALL',
    level: 'ALL',
    target: '',
    operator: '',
    q: '',
    from: '',
    to: '',
  });

  const auditUrl = (() => {
    const params = new URLSearchParams({
      action: queryPayload.action,
      level: queryPayload.level,
      target: queryPayload.target,
      operator: queryPayload.operator,
      q: queryPayload.q,
      from: queryPayload.from,
      to: queryPayload.to,
      limit: '1000',
    });
    return `/api/audit?${params.toString()}`;
  })();

  const { data, error: fetchError, isLoading: loading, mutate } = useSWR(auditUrl, fetcher);
  const logs: AuditLog[] = data?.logs || [];
  const filteredTotal = data?.filteredTotal ?? logs.length;
  const totalScanned = data?.totalScanned ?? 0;
  const error = fetchError ? fetchError.message : '';

  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const handleQuery = () => {
    // Combine fields into target if necessary, or just pick the non-empty one
    const target = inputImsi.trim() || inputProfile.trim();
    setQueryPayload({
      action: inputAction,
      level: inputLevel,
      target,
      operator: inputOperator.trim(),
      q: inputKeyword.trim(),
      from: inputFrom,
      to: inputTo,
    });
  };

  const handleReset = () => {
    setInputAction('ALL');
    setInputLevel('ALL');
    setInputImsi('');
    setInputProfile('');
    setInputOperator('');
    setInputKeyword('');
    setInputFrom('');
    setInputTo('');
    setQueryPayload({ action: 'ALL', level: 'ALL', target: '', operator: '', q: '', from: '', to: '' });
  };

  const exportLogs = () => {
    if (logs.length === 0) return;
    const basename = `xcloud_audit_${new Date().toISOString().slice(0, 10)}`;
    let blob: Blob;
    let filename: string;

    if (exportFormat === 'json') {
      blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json;charset=utf-8;' });
      filename = `${basename}.json`;
    } else {
      const header = toCsvRow(['Timestamp', 'Level', 'Action', 'Target', 'Operator IP', 'Old Data', 'New Data']);
      const rows = logs.map(log => toCsvRow([
        log.timestamp,
        log.level,
        log.action,
        log.targetId,
        log.operatorIp,
        log.oldData ? JSON.stringify(log.oldData) : '',
        log.newData ? JSON.stringify(log.newData) : '',
      ]));
      blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
      filename = `${basename}.csv`;
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="container animate-fade-in" style={{ padding: "3rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "2.5rem" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "2rem", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <History size={32} color="var(--primary)" /> {t("audit_title")}
            </h1>
            <p style={{ color: "var(--text-muted)", marginTop: "0.5rem", fontSize: "0.95rem" }}>
              {t("audit_subtitle")}
            </p>
          </div>
          <div style={{ background: "rgba(59, 130, 246, 0.12)", color: "var(--primary)", padding: "0.5rem 1rem", borderRadius: "20px", fontSize: "0.85rem", fontWeight: 600, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Activity size={16} /> {t("audit_tracking")}
          </div>
        </div>

        <div className="glass-card" style={{ marginBottom: "2rem", padding: "1.5rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "180px 160px minmax(180px, 1fr) minmax(180px, 1fr) auto", gap: "16px", alignItems: "flex-end" }}>
            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_action")}</label>
              <select className="form-input" value={inputAction} onChange={e => setInputAction(e.target.value)} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem", width: "100%" }}>
                <option value="ALL">{t("audit_action_all")}</option>
                <option value="CREATE">{t("audit_action_create")}</option>
                <option value="UPDATE">{t("audit_action_update")}</option>
                <option value="DELETE">{t("audit_action_delete")}</option>
                <option value="BATCH_CREATE">{t("audit_action_BATCH_CREATE")}</option>
                <option value="CSV_IMPORT">{t("audit_action_csv_import")}</option>
                <option value="HEAL">{t("audit_action_HEAL")}</option>
                <option value="PROFILE_CREATE">{t("audit_action_profile_create")}</option>
                <option value="PROFILE_UPDATE">{t("audit_action_profile_update")}</option>
                <option value="PROFILE_DELETE">{t("audit_action_profile_delete")}</option>
              </select>
            </div>

            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_level")}</label>
              <select className="form-input" value={inputLevel} onChange={e => setInputLevel(e.target.value)} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem", width: "100%" }}>
                <option value="ALL">{t("audit_level_all")}</option>
                <option value="info">{t("audit_level_info")}</option>
                <option value="warning">{t("audit_level_warning")}</option>
              </select>
            </div>

            <div>
               <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_imsi")}</label>
               <div style={{ position: "relative" }}>
                 <input
                   type="text"
                   className="form-input"
                   placeholder={t("audit_imsi_placeholder")}
                   value={inputImsi}
                   onChange={e => {
                     const val = e.target.value.replace(/\D/g, '');
                     if (val.length <= 15) setInputImsi(val);
                   }}
                   style={{ height: "40px", width: "100%", padding: "0 2.25rem 0 0.75rem", fontSize: "0.9rem" }}
                 />
                 {inputImsi && (
                   <button onClick={() => setInputImsi('')} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center" }}>
                     <X size={15} />
                   </button>
                 )}
               </div>
            </div>

            <div>
               <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_profile")}</label>
               <div style={{ position: "relative" }}>
                 <input
                   type="text"
                   className="form-input"
                   placeholder={t("audit_profile_placeholder")}
                   value={inputProfile}
                   onChange={e => setInputProfile(e.target.value)}
                   style={{ height: "40px", width: "100%", padding: "0 2.25rem 0 0.75rem", fontSize: "0.9rem" }}
                 />
                 {inputProfile && (
                   <button onClick={() => setInputProfile('')} style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center" }}>
                     <X size={15} />
                   </button>
                 )}
               </div>
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              <button className="btn btn-primary" onClick={handleQuery} style={{ height: "40px", padding: "0 1.5rem", fontSize: "0.9rem" }}>{t("audit_btn_query")}</button>
              <button className="btn btn-outline" onClick={handleReset} style={{ height: "40px", padding: "0 1.5rem", fontSize: "0.9rem" }}>{t("audit_btn_reset")}</button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr)) auto", gap: "16px", alignItems: "flex-end", marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--surface-border)" }}>
            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_from")}</label>
              <input type="date" className="form-input" value={inputFrom} onChange={e => setInputFrom(e.target.value)} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem" }} />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_to")}</label>
              <input type="date" className="form-input" value={inputTo} onChange={e => setInputTo(e.target.value)} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem" }} />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_operator")}</label>
              <input type="text" className="form-input" placeholder={t("audit_operator_placeholder")} value={inputOperator} onChange={e => setInputOperator(e.target.value)} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem" }} />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_keyword")}</label>
              <input type="text" className="form-input" placeholder={t("audit_keyword_placeholder")} value={inputKeyword} onChange={e => setInputKeyword(e.target.value)} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem" }} />
            </div>
            <div>
              <label className="form-label" style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "6px" }}>{t("audit_filter_export")}</label>
              <select className="form-input" value={exportFormat} onChange={e => setExportFormat(e.target.value as 'csv' | 'json')} style={{ height: "40px", padding: "0 0.75rem", fontSize: "0.9rem" }}>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <button className="btn btn-outline" onClick={() => mutate()} title={t("audit_refresh")} style={{ height: "40px", padding: "0 0.85rem", fontSize: "0.9rem" }}>
                <RefreshCw size={15} />
              </button>
              <button className="btn btn-outline" onClick={exportLogs} disabled={logs.length === 0} style={{ height: "40px", padding: "0 1rem", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", gap: "0.45rem" }}>
                <Download size={15} /> {t("audit_export")}
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "-0.75rem 0 1rem", color: "var(--text-muted)", fontSize: "0.85rem", gap: "1rem", flexWrap: "wrap" }}>
          <span>
            {t("audit_summary_showing")} <strong style={{ color: "var(--text-main)" }}>{logs.length}</strong> {t("audit_summary_of")} <strong style={{ color: "var(--text-main)" }}>{filteredTotal}</strong> {t("audit_summary_matched")}
            {totalScanned > 0 ? <> {t("audit_summary_from")} <strong style={{ color: "var(--text-main)" }}>{totalScanned}</strong> {t("audit_summary_scanned")}</> : null}
          </span>
          <span>
            {queryPayload.action !== 'ALL' ? queryPayload.action : t("audit_summary_all_actions")}
            {queryPayload.level !== 'ALL' ? ` · ${queryPayload.level}` : ''}
            {queryPayload.from || queryPayload.to ? ` · ${queryPayload.from || '...'} - ${queryPayload.to || '...'}` : ''}
          </span>
        </div>

        <div className="glass-card" style={{ padding: 0, overflow: "hidden" }}>
          {loading ? (
             <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted)" }}>{t("audit_loading")}</div>
          ) : error ? (
             <div style={{ padding: "2rem", color: "var(--danger)", textAlign: "center" }}>{error}</div>
          ) : logs.length === 0 ? (
             <div style={{ padding: "4rem", textAlign: "center", color: "var(--text-muted)" }}>{t("audit_no_data")}</div>
          ) : (
            <table className="data-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ background: "var(--surface-hover)", borderBottom: "2px solid var(--surface-border)" }}>
                <tr>
                   <th style={{ padding: "1.25rem", textAlign: "left", fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-secondary)", width: "180px" }}>{t("audit_col_time")}</th>
                   <th style={{ padding: "1.25rem", textAlign: "left", fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-secondary)" }}>{t("audit_col_action")}</th>
                   <th style={{ padding: "1.25rem", textAlign: "left", fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-secondary)" }}>{t("audit_col_target")}</th>
                   <th style={{ padding: "1.25rem", textAlign: "left", fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-secondary)" }}>{t("audit_col_operator")}</th>
                   <th style={{ padding: "1.25rem", textAlign: "right", fontSize: "0.8rem", textTransform: "uppercase", color: "var(--text-secondary)" }}>{t("audit_col_delta")}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} style={{ borderBottom: "1px solid var(--surface-border)", background: log.level === 'warning' ? 'rgba(239, 68, 68, 0.08)' : 'transparent' }}>
                    <td style={{ padding: "1rem 1.25rem", color: "var(--text-secondary)", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td style={{ padding: "1rem 1.25rem" }}>
                      <span className="pill" style={{
                        background: log.level === 'warning' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                        color: log.level === 'warning' ? 'var(--danger)' : 'var(--primary)',
                        border: `1px solid ${log.level === 'warning' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(59, 130, 246, 0.3)'}`
                      }}>
                        {log.level === 'warning' && <ShieldAlert size={12} style={{ marginRight: "0.25rem" }}/>}
                        {t(`audit_action_${log.action}` as any) !== `audit_action_${log.action}` ? t(`audit_action_${log.action}` as any) : log.action}
                      </span>
                    </td>
                    <td style={{ padding: "1rem 1.25rem", fontWeight: 600, color: "var(--text-main)" }}>
                      {log.targetId}
                    </td>
                    <td style={{ padding: "1rem 1.25rem", fontFamily: "monospace", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                      {log.operatorIp}
                    </td>
                    <td style={{ padding: "1rem 1.25rem", textAlign: "right" }}>
                      <button
                         className="btn btn-outline"
                         onClick={() => setSelectedLog(log)}
                         style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: "6px" }}
                      >
                         <Braces size={14} style={{ marginRight: "4px" }}/> {t("audit_btn_inspect")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* JSON Diff Inspector Modal */}
      {selectedLog && (
        <div className="modal-overlay" style={{ zIndex: 9999 }}>
          <div className="modal-content animate-fade-in" style={{ width: "900px", maxWidth: "95vw", borderRadius: "12px", overflow: "hidden", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "1.5rem 2rem", borderBottom: "1px solid var(--surface-border)", background: "var(--surface-hover)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600 }}>{t("audit_modal_title")}</h2>
                <div style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "0.25rem" }}>
                  {t("audit_modal_ref")} <span style={{ fontFamily: "monospace" }}>{selectedLog.id}</span>
                </div>
              </div>
              <button className="btn btn-outline" onClick={() => setSelectedLog(null)}>{t("audit_modal_close")}</button>
            </div>

            <div style={{ padding: "1.5rem 2rem", flex: 1, overflowY: "auto", display: "flex", gap: "1rem" }}>
              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: "0.5rem", fontWeight: 600, color: "var(--danger)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }}/> {t("audit_modal_old")}
                </div>
                <div style={{ background: "#1e1e1e", borderRadius: "8px", padding: "1rem", overflowX: "auto" }}>
                  <pre style={{ margin: 0, color: "#d4d4d4", fontFamily: "monospace", fontSize: "0.85rem", lineHeight: 1.5 }}>
                    {selectedLog.oldData ? JSON.stringify(selectedLog.oldData, null, 2) : t("audit_modal_null_old")}
                  </pre>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", color: "var(--surface-border)" }}>
                <ChevronRight size={32} />
              </div>

              <div style={{ flex: 1 }}>
                <div style={{ marginBottom: "0.5rem", fontWeight: 600, color: "var(--success)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)" }}/> {t("audit_modal_new")}
                </div>
                <div style={{ background: "#1e1e1e", borderRadius: "8px", padding: "1rem", overflowX: "auto" }}>
                  <pre style={{ margin: 0, color: "#d4d4d4", fontFamily: "monospace", fontSize: "0.85rem", lineHeight: 1.5 }}>
                    {selectedLog.newData ? JSON.stringify(selectedLog.newData, null, 2) : t("audit_modal_null_new")}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
