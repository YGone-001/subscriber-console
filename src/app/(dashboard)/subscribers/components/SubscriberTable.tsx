import React from "react";
import { Plus, Users, CheckCircle2, Copy, PenLine, Trash2, MoreHorizontal } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import * as T from "../types";

export function SubscriberTable(props: any) {
  const { t } = useI18n();
  const {
    isLoading, totalSubscribers, searchQuery, statusFilter, canEditSubscribers,
    handleOpenNew, isAllPageSelected, selectedOnPageCount, pageImsis,
    toggleSelectAll, sortField, handleSort, renderSortIcon, paginatedSubscribers,
    selectedImsis, setSelectedImsis, copiedImsi, handleCopyImsi, resolveNetwork,
    formatBytes, formatFullDate, timeAgo, handleOpenEdit, handleDelete,
    isDeletingSingle, pendingDelete, activeDropdown, setActiveDropdown,
    setTraceImsi, handleOpenTrafficAdjustment
  } = props;

  if (isLoading) {
    return <LoadingRows columns={canEditSubscribers ? 8 : 7} rows={5} />;
  }

  if (totalSubscribers === 0) {
    return (
      <EmptyState
        icon={<Users size={48} />}
        title={searchQuery || statusFilter !== "all" ? t("no_subscribers_search") : t("no_subscribers_empty")}
        description={searchQuery || statusFilter !== "all" ? t("sub_empty_search_desc") : t("sub_empty_create_desc")}
        action={
          canEditSubscribers && !searchQuery && statusFilter === "all" ? (
            <button type="button" className="btn btn-primary" onClick={handleOpenNew}>
              <Plus size={16} /> {t("add_subscriber")}
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="table-wrapper">
      <table className="subscribers-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                className="checkbox-custom"
                checked={isAllPageSelected}
                ref={input => { if (input) input.indeterminate = selectedOnPageCount > 0 && selectedOnPageCount < pageImsis.length }}
                onChange={toggleSelectAll}
              />
            </th>
            <th className={sortField === "status" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("status")}>
              <span>{t("col_status")}</span> {renderSortIcon("status")}
            </th>
            <th className={sortField === "imsi" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("imsi")}>
              <span>{t("col_imsi")}</span> {renderSortIcon("imsi")}
            </th>
            <th className={sortField === "plmn" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("plmn")}>
              <span>{t("col_plmn")}</span> {renderSortIcon("plmn")}
            </th>
            <th className={sortField === "policy" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("policy")}>
              <span>{t("col_policy")}</span> {renderSortIcon("policy")}
            </th>
            <th className={sortField === "usage" ? "sortable-th active" : "sortable-th"} style={{ minWidth: "150px" }} onClick={() => handleSort("usage")}>
              <span>{t("col_traffic")}</span> {renderSortIcon("usage")}
            </th>
            <th className={sortField === "lastActive" ? "sortable-th active" : "sortable-th"} onClick={() => handleSort("lastActive")}>
              <span>{t("col_last_active")}</span> {renderSortIcon("lastActive")}
            </th>
            {canEditSubscribers && <th style={{ padding: "1rem", color: "var(--text-secondary)", fontWeight: 600, textAlign: "center" }}>{t("col_actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {paginatedSubscribers.map((sub: any) => {
             const uRatio = sub.traffic?.total ? (sub.traffic.used / sub.traffic.total) * 100 : 0;
             const isSelected = selectedImsis.includes(sub.imsi);
             return (
               <tr key={sub.imsi} className={isSelected ? "selected-row" : ""}>
                 <td>
                   <input type="checkbox" className="checkbox-custom" checked={isSelected} onChange={() => setSelectedImsis((prev: string[]) => prev.includes(sub.imsi) ? prev.filter(i => i !== sub.imsi) : [...prev, sub.imsi])} />
                 </td>
                 <td>
                   {(() => {
                     const isSuspended = sub.status === 'Suspended';
                     const isActive = sub.status === 'Active';
                     const isPartial = sub.status === 'Partial Restricted';

                     const MAPPING = [
                       { bit: 128, label: "5G" },
                       { bit: 64, label: "NB" },
                       { bit: 32, label: "Non-3GPP" },
                       { bit: 16, label: "4G" },
                       { bit: 8, label: "HSPA" },
                       { bit: 4, label: "GAN" },
                       { bit: 2, label: "2G" },
                       { bit: 1, label: "3G" }
                     ];

                     let tooltip = "";
                     if (isPartial && sub.ard != null) {
                       const ard = sub.ard;
                       tooltip = MAPPING.filter(item => (ard & item.bit)).map(item => item.label).join(', ');
                     }

                     return (
                       <span className={`status-badge ${isActive ? "active pill-active-pulse" : isSuspended ? "suspended" : "partial"} ${tooltip ? "has-tooltip" : ""}`} title={tooltip || undefined}>
                         {isActive ? t("status_active") : isSuspended ? t("status_suspended") : isPartial ? t("status_partial") : sub.status}
                       </span>
                     );
                   })()}
                 </td>
                 <td>
                   <div className="imsi-text-container">
                     <span className="imsi-text">{sub.imsi}</span>
                     <button
                       className={copiedImsi === sub.imsi ? "copy-btn copied" : "copy-btn"}
                       onClick={(event) => handleCopyImsi(sub.imsi, event)}
                       title={copiedImsi === sub.imsi ? "Copied" : "Copy IMSI"}
                     >
                       {copiedImsi === sub.imsi ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                     </button>
                   </div>
                 </td>
                 <td>
                   {(() => {
                      const net = resolveNetwork(sub.imsi);
                      const tooltipText = net.network !== 'Unknown'
                        ? `${net.network} - ${net.country}${net.country_code ? ' (+' + net.country_code + ')' : ''}`
                        : t("unknown_network");
                      return (
                        <span title={tooltipText} className="plmn-badge">{net.plmn}</span>
                      );
                   })()}
                 </td>
                  <td>
                     {sub.policy ? (
                       <div className="policy-container">
                         <span title={sub.policy} className="policy-text">
                           {sub.policyName || sub.policy}
                         </span>
                         <span className="policy-subtext">
                           {sub.policy}
                           {sub.policyStatus === "disabled" && (
                             <span className="policy-disabled">
                               {t("users_disabled")}
                             </span>
                           )}
                         </span>
                       </div>
                     ) : (
                       <span className="no-policy">{t("no_policy")}</span>
                     )}
                 </td>
                 <td>
                   <div className="traffic-container">
                      <div className="traffic-stats">
                        <span>{formatBytes(sub.traffic?.used || 0)}</span>
                        <span>{formatBytes(sub.traffic?.total || 1)}</span>
                      </div>
                      <div className="traffic-bar-container">
                        <div className={`traffic-bar ${uRatio > 90 ? "high" : uRatio > 70 ? "medium" : "low"}`} style={{ width: `${Math.min(uRatio, 100)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="last-active-cell">
                    <span title={formatFullDate(sub.lastActive)} className="last-active-text">
                      {timeAgo(sub.lastActive)}
                    </span>
                  </td>
                  {canEditSubscribers && (
                    <td className="actions-cell">
                       <button className="action-btn action-btn-primary" onClick={(e) => { e.stopPropagation(); handleOpenEdit(sub.imsi); }} title={t("action_edit")}>
                         <PenLine size={18} />
                       </button>
                       <button className="action-btn action-btn-danger" onClick={(e) => handleDelete(sub.imsi, e)} title={t("action_delete")} disabled={isDeletingSingle === sub.imsi || Boolean(pendingDelete)}>
                         {isDeletingSingle === sub.imsi ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : <Trash2 size={18} />}
                       </button>
                       <div className="dropdown-container">
                         <button className="action-btn action-btn-muted" title={t("action_more")} onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === sub.imsi ? null : sub.imsi); }}>
                           <MoreHorizontal size={18} />
                         </button>
                         {activeDropdown === sub.imsi && (
                           <div className="dropdown-menu">
                             <button className="dropdown-menu-item" onClick={(e) => {e.stopPropagation(); setActiveDropdown(null); setTraceImsi(sub.imsi);}}>{t("action_trace")}</button>
                             <button className="dropdown-menu-item" onClick={(e) => handleOpenTrafficAdjustment(sub, "recharge", e)}>{t("traffic_adjust")}</button>
                             <button className="dropdown-menu-item" onClick={(e) => handleOpenTrafficAdjustment(sub, "reset", e)}>{t("action_reset")}</button>
                           </div>
                         )}
                       </div>
                    </td>
                  )}
               </tr>
             );
          })}
        </tbody>
      </table>
    </div>
  );
}
