"use client";

import React, { useMemo, useState } from 'react';
import { ShieldAlert, History, Activity, Braces, X, Download, RefreshCw, AlertTriangle, DatabaseZap, Gauge, Target, UserRound } from 'lucide-react';
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useI18n } from "@/components/I18nProvider";
import { toCsvRow } from "@/lib/csv";
import VisualDiffViewer from "@/components/VisualDiffViewer";
import './audit-logs.css';

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

type AuditQuickFilter = 'warnings' | 'profile' | 'traffic' | 'destructive';

const DESTRUCTIVE_ACTIONS = new Set(['DELETE', 'PROFILE_DELETE', 'TRAFFIC_RESET']);

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
  const logRows = data?.logs as AuditLog[] | undefined;
  const logs = useMemo(() => logRows || [], [logRows]);
  const filteredTotal = data?.filteredTotal ?? logs.length;
  const totalScanned = data?.totalScanned ?? 0;
  const error = fetchError ? fetchError.message : '';

  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  const formatActionLabel = (action: string) => {
    const key = `audit_action_${action}`;
    const label = t(key as any);
    return label !== key ? label : action;
  };

  const auditSummary = useMemo(() => {
    const actionCounts = new Map<string, number>();
    const operatorCounts = new Map<string, number>();
    const targetCounts = new Map<string, number>();
    let warningCount = 0;
    let destructiveCount = 0;
    let profileChangeCount = 0;
    let trafficChangeCount = 0;

    logs.forEach(log => {
      actionCounts.set(log.action, (actionCounts.get(log.action) || 0) + 1);
      operatorCounts.set(log.operatorIp || 'unknown', (operatorCounts.get(log.operatorIp || 'unknown') || 0) + 1);
      targetCounts.set(log.targetId || 'unknown', (targetCounts.get(log.targetId || 'unknown') || 0) + 1);
      if (log.level === 'warning') warningCount += 1;
      if (DESTRUCTIVE_ACTIONS.has(log.action)) destructiveCount += 1;
      if (log.action.startsWith('PROFILE_')) profileChangeCount += 1;
      if (log.action.startsWith('TRAFFIC_')) trafficChangeCount += 1;
    });

    const topList = (map: Map<string, number>) => Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    return {
      warningCount,
      destructiveCount,
      profileChangeCount,
      trafficChangeCount,
      uniqueTargets: targetCounts.size,
      topActions: topList(actionCounts),
      topOperators: topList(operatorCounts),
      topTargets: topList(targetCounts),
    };
  }, [logs]);

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

  const applyQuickFilter = (filter: AuditQuickFilter) => {
    const nextPayload = {
      action: 'ALL',
      level: 'ALL',
      target: '',
      operator: '',
      q: '',
      from: '',
      to: '',
    };

    if (filter === 'warnings') nextPayload.level = 'warning';
    if (filter === 'profile') nextPayload.q = 'PROFILE_';
    if (filter === 'traffic') nextPayload.q = 'TRAFFIC_';
    if (filter === 'destructive') nextPayload.q = 'DELETE';

    setInputAction(nextPayload.action);
    setInputLevel(nextPayload.level);
    setInputImsi('');
    setInputProfile('');
    setInputOperator('');
    setInputKeyword(nextPayload.q);
    setInputFrom('');
    setInputTo('');
    setQueryPayload(nextPayload);
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
      <div className="container animate-fade-in audit-container">
        <div className="audit-header">
          <div>
            <h1 className="audit-title">
              <History size={32} color="var(--primary)" /> {t("audit_title")}
            </h1>
            <p className="audit-subtitle">
              {t("audit_subtitle")}
            </p>
          </div>
          <div className="audit-tracking">
            <Activity size={16} /> {t("audit_tracking")}
          </div>
        </div>

        <div className="audit-metrics-grid">
          {[
            { icon: <Gauge size={18} color="var(--primary)" />, label: t("audit_ops_matched"), value: filteredTotal },
            { icon: <ShieldAlert size={18} color="var(--danger)" />, label: t("audit_ops_warnings"), value: auditSummary.warningCount },
            { icon: <AlertTriangle size={18} color="var(--danger)" />, label: t("audit_ops_destructive"), value: auditSummary.destructiveCount },
            { icon: <Target size={18} color="var(--primary)" />, label: t("audit_ops_targets"), value: auditSummary.uniqueTargets },
          ].map(metric => (
            <div key={metric.label} className="dash-card audit-metric-card">
              <div className="audit-metric-icon">
                {metric.icon}
              </div>
              <div className="audit-metric-content">
                <div className="audit-metric-label">{metric.label}</div>
                <div className="audit-metric-value">{metric.value}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="glass-card audit-hot-actions-grid">
          <div>
            <div className="audit-hot-header">
              <Activity size={16} color="var(--primary)" /> {t("audit_hot_actions")}
            </div>
            <div className="audit-hot-list">
              {auditSummary.topActions.length === 0 ? (
                <span className="audit-hot-empty">{t("audit_no_data")}</span>
              ) : auditSummary.topActions.map(item => (
                <div key={item.name} className="audit-hot-item">
                  <span className="audit-hot-item-label">{formatActionLabel(item.name)}</span>
                  <strong className="audit-hot-item-value">{item.count}</strong>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="audit-hot-header">
              <UserRound size={16} color="var(--primary)" /> {t("audit_hot_operators")}
            </div>
            <div className="audit-hot-list">
              {auditSummary.topOperators.length === 0 ? (
                <span className="audit-hot-empty">{t("audit_no_data")}</span>
              ) : auditSummary.topOperators.map(item => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => {
                    setInputOperator(item.name);
                    setQueryPayload({ ...queryPayload, operator: item.name });
                  }}
                  className="audit-hot-btn"
                >
                  <span className="audit-hot-btn-label">{item.name}</span>
                  <strong className="audit-hot-item-value">{item.count}</strong>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="audit-hot-header">
              <DatabaseZap size={16} color="var(--primary)" /> {t("audit_fast_filters")}
            </div>
            <div className="audit-quick-filters">
              <button type="button" className="btn btn-outline audit-quick-btn" onClick={() => applyQuickFilter('warnings')}>{t("audit_quick_warnings")}</button>
              <button type="button" className="btn btn-outline audit-quick-btn" onClick={() => applyQuickFilter('profile')}>{t("audit_quick_profile")} ({auditSummary.profileChangeCount})</button>
              <button type="button" className="btn btn-outline audit-quick-btn" onClick={() => applyQuickFilter('traffic')}>{t("audit_quick_traffic")} ({auditSummary.trafficChangeCount})</button>
              <button type="button" className="btn btn-outline audit-quick-btn" onClick={() => applyQuickFilter('destructive')}>{t("audit_quick_destructive")}</button>
            </div>
            <div className="audit-quick-hint">
              {t("audit_fast_filters_hint")}
            </div>
            <div className="audit-targets-container">
              <div className="audit-targets-title">{t("audit_hot_targets")}</div>
              <div className="audit-hot-list">
                {auditSummary.topTargets.length === 0 ? (
                  <span className="audit-hot-empty">{t("audit_no_data")}</span>
                ) : auditSummary.topTargets.map(item => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => {
                      setInputImsi(/^\d{1,15}$/.test(item.name) ? item.name : '');
                      setInputProfile(/^\d{1,15}$/.test(item.name) ? '' : item.name);
                      setQueryPayload({ ...queryPayload, target: item.name });
                    }}
                    className="audit-hot-btn"
                  >
                    <span className="audit-hot-btn-label">{item.name}</span>
                    <strong className="audit-hot-item-value">{item.count}</strong>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="glass-card audit-filters-card">
          <div className="audit-filters-row1">
            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_action")}</label>
              <select className="form-input audit-filter-input" value={inputAction} onChange={e => setInputAction(e.target.value)}>
                <option value="ALL">{t("audit_action_all")}</option>
                <option value="CREATE">{t("audit_action_create")}</option>
                <option value="UPDATE">{t("audit_action_update")}</option>
                <option value="DELETE">{t("audit_action_delete")}</option>
                <option value="BATCH_CREATE">{t("audit_action_BATCH_CREATE")}</option>
                <option value="CSV_IMPORT">{t("audit_action_csv_import")}</option>
                <option value="HEAL">{t("audit_action_HEAL")}</option>
                <option value="TRAFFIC_RECHARGE">{t("audit_action_TRAFFIC_RECHARGE")}</option>
                <option value="TRAFFIC_ADJUST">{t("audit_action_TRAFFIC_ADJUST")}</option>
                <option value="TRAFFIC_RESET">{t("audit_action_TRAFFIC_RESET")}</option>
                <option value="PROFILE_CREATE">{t("audit_action_profile_create")}</option>
                <option value="PROFILE_UPDATE">{t("audit_action_profile_update")}</option>
                <option value="PROFILE_DELETE">{t("audit_action_profile_delete")}</option>
              </select>
            </div>

            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_level")}</label>
              <select className="form-input audit-filter-input" value={inputLevel} onChange={e => setInputLevel(e.target.value)}>
                <option value="ALL">{t("audit_level_all")}</option>
                <option value="info">{t("audit_level_info")}</option>
                <option value="warning">{t("audit_level_warning")}</option>
              </select>
            </div>

            <div>
               <label className="form-label audit-filter-label">{t("audit_filter_imsi")}</label>
               <div className="audit-filter-input-wrap">
                 <input
                   type="text"
                   className="form-input audit-filter-input-icon"
                   placeholder={t("audit_imsi_placeholder")}
                   value={inputImsi}
                   onChange={e => {
                     const val = e.target.value.replace(/\D/g, '');
                     if (val.length <= 15) setInputImsi(val);
                   }}
                 />
                 {inputImsi && (
                   <button onClick={() => setInputImsi('')} className="audit-filter-clear">
                     <X size={15} />
                   </button>
                 )}
               </div>
            </div>

            <div>
               <label className="form-label audit-filter-label">{t("audit_filter_profile")}</label>
               <div className="audit-filter-input-wrap">
                 <input
                   type="text"
                   className="form-input audit-filter-input-icon"
                   placeholder={t("audit_profile_placeholder")}
                   value={inputProfile}
                   onChange={e => setInputProfile(e.target.value)}
                 />
                 {inputProfile && (
                   <button onClick={() => setInputProfile('')} className="audit-filter-clear">
                     <X size={15} />
                   </button>
                 )}
               </div>
            </div>

            <div className="audit-filter-btns">
              <button className="btn btn-primary audit-filter-btn" onClick={handleQuery}>{t("audit_btn_query")}</button>
              <button className="btn btn-outline audit-filter-btn" onClick={handleReset}>{t("audit_btn_reset")}</button>
            </div>
          </div>

          <div className="audit-filters-row2">
            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_from")}</label>
              <input type="date" className="form-input audit-filter-input" value={inputFrom} onChange={e => setInputFrom(e.target.value)} />
            </div>
            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_to")}</label>
              <input type="date" className="form-input audit-filter-input" value={inputTo} onChange={e => setInputTo(e.target.value)} />
            </div>
            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_operator")}</label>
              <input type="text" className="form-input audit-filter-input" placeholder={t("audit_operator_placeholder")} value={inputOperator} onChange={e => setInputOperator(e.target.value)} />
            </div>
            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_keyword")}</label>
              <input type="text" className="form-input audit-filter-input" placeholder={t("audit_keyword_placeholder")} value={inputKeyword} onChange={e => setInputKeyword(e.target.value)} />
            </div>
            <div>
              <label className="form-label audit-filter-label">{t("audit_filter_export")}</label>
              <select className="form-input audit-filter-input" value={exportFormat} onChange={e => setExportFormat(e.target.value as 'csv' | 'json')}>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </div>
            <div className="audit-action-btns">
              <button className="btn btn-outline audit-refresh-btn" onClick={() => mutate()} title={t("audit_refresh")}>
                <RefreshCw size={15} />
              </button>
              <button className="btn btn-outline audit-export-btn" onClick={exportLogs} disabled={logs.length === 0}>
                <Download size={15} /> {t("audit_export")}
              </button>
            </div>
          </div>
        </div>

        <div className="audit-summary">
          <span>
            {t("audit_summary_showing")} <strong className="audit-summary-highlight">{logs.length}</strong> {t("audit_summary_of")} <strong className="audit-summary-highlight">{filteredTotal}</strong> {t("audit_summary_matched")}
            {totalScanned > 0 ? <> {t("audit_summary_from")} <strong className="audit-summary-highlight">{totalScanned}</strong> {t("audit_summary_scanned")}</> : null}
          </span>
          <span>
            {queryPayload.action !== 'ALL' ? queryPayload.action : t("audit_summary_all_actions")}
            {queryPayload.level !== 'ALL' ? ` · ${queryPayload.level}` : ''}
            {queryPayload.from || queryPayload.to ? ` · ${queryPayload.from || '...'} - ${queryPayload.to || '...'}` : ''}
          </span>
        </div>

        <div className="glass-card audit-table-card">
          {loading ? (
             <div className="audit-table-msg">{t("audit_loading")}</div>
          ) : error ? (
             <div className="audit-table-err">{error}</div>
          ) : logs.length === 0 ? (
             <div className="audit-table-msg">{t("audit_no_data")}</div>
          ) : (
            <table className="data-table audit-table">
              <thead className="audit-table-thead">
                <tr>
                   <th className="audit-table-th audit-table-th-time">{t("audit_col_time")}</th>
                   <th className="audit-table-th">{t("audit_col_action")}</th>
                   <th className="audit-table-th">{t("audit_col_target")}</th>
                   <th className="audit-table-th">{t("audit_col_operator")}</th>
                   <th className="audit-table-th audit-table-th-delta">{t("audit_col_delta")}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} className={log.level === 'warning' ? 'audit-table-tr-warning' : 'audit-table-tr'}>
                    <td className="audit-table-td-time">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="audit-table-td">
                      <span className={`pill ${log.level === 'warning' ? 'audit-pill-warning' : 'audit-pill-primary'}`}>
                        {log.level === 'warning' && <ShieldAlert size={12} className="audit-pill-icon" />}
                        {formatActionLabel(log.action)}
                      </span>
                    </td>
                    <td className="audit-table-td-target">
                      {log.targetId}
                    </td>
                    <td className="audit-table-td-operator">
                      {log.operatorIp}
                    </td>
                    <td className="audit-table-td-delta">
                      <button
                         className="btn btn-outline audit-inspect-btn"
                         onClick={() => setSelectedLog(log)}
                      >
                         <Braces size={14} className="audit-inspect-icon" /> {t("audit_btn_inspect")}
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
        <div className="modal-overlay audit-modal-overlay">
          <div className="modal-content animate-fade-in audit-modal-content">
            <div className="audit-modal-header">
              <div>
                <h2 className="audit-modal-title">{t("audit_modal_title")}</h2>
                <div className="audit-modal-ref">
                  {t("audit_modal_ref")} <span className="audit-modal-ref-id">{selectedLog.id}</span> · <span className="audit-modal-ref-action">{formatActionLabel(selectedLog.action)}</span> ({selectedLog.targetId})
                </div>
              </div>
              <button className="btn btn-outline" onClick={() => setSelectedLog(null)}>{t("audit_modal_close")}</button>
            </div>

            <div className="audit-modal-body" style={{ padding: '1rem 1.5rem', display: 'block' }}>
              <VisualDiffViewer
                oldData={selectedLog.oldData}
                newData={selectedLog.newData}
                title={`${formatActionLabel(selectedLog.action)} · ${selectedLog.targetId}`}
                defaultMode="semantic"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
