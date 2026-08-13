import React from "react";
import { Plus, Users, CheckCircle2, Copy, PenLine, Trash2, MoreHorizontal } from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { EmptyState, LoadingRows } from "@/components/OperationFeedback";
import { SortableTableHeader } from "@/components/ui/SortableTableHeader";

export function SubscriberTable(props: any) {
  const { t } = useI18n();
  const {
    isLoading, totalSubscribers, searchQuery, statusFilter, canEditSubscribers,
    handleOpenNew, isAllPageSelected, selectedOnPageCount, pageImsis,
    toggleSelectAll, sortField, sortDirection, handleSort, renderSortIcon, paginatedSubscribers,
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
      <div className="mobile-table-controls" aria-label={t("nav_tab_options")}>
        <label className="mobile-select-all">
          <input
            type="checkbox"
            className="checkbox-custom"
            checked={isAllPageSelected}
            ref={input => { if (input) input.indeterminate = selectedOnPageCount > 0 && selectedOnPageCount < pageImsis.length }}
            onChange={toggleSelectAll}
          />
          <span>{t("table_select_all_subscribers")}</span>
        </label>
        <div className="mobile-sort-strip" aria-label={t("nav_tab_options")}>
          {[
            ["status", t("col_status")],
            ["imsi", t("col_imsi")],
            ["usage", t("col_traffic")],
            ["lastActive", t("col_last_active")],
          ].map(([field, label]) => (
            <button
              key={field}
              type="button"
              className={sortField === field ? "mobile-sort-button active" : "mobile-sort-button"}
              aria-pressed={sortField === field}
              onClick={() => handleSort(field)}
            >
              {label}{sortField === field ? renderSortIcon(field) : null}
            </button>
          ))}
        </div>
      </div>
      <table className="subscribers-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                className="checkbox-custom"
                aria-label={t("table_select_all_subscribers")}
                checked={isAllPageSelected}
                ref={input => { if (input) input.indeterminate = selectedOnPageCount > 0 && selectedOnPageCount < pageImsis.length }}
                onChange={toggleSelectAll}
              />
            </th>
            <SortableTableHeader label={t("col_status")} active={sortField === "status"} direction={sortDirection} icon={renderSortIcon("status")} onSort={() => handleSort("status")} />
            <SortableTableHeader label={t("col_imsi")} active={sortField === "imsi"} direction={sortDirection} icon={renderSortIcon("imsi")} onSort={() => handleSort("imsi")} />
            <SortableTableHeader label={t("col_plmn")} active={sortField === "plmn"} direction={sortDirection} icon={renderSortIcon("plmn")} onSort={() => handleSort("plmn")} />
            <SortableTableHeader label={t("col_policy")} active={sortField === "policy"} direction={sortDirection} icon={renderSortIcon("policy")} onSort={() => handleSort("policy")} />
            <SortableTableHeader label={t("col_traffic")} active={sortField === "usage"} direction={sortDirection} icon={renderSortIcon("usage")} onSort={() => handleSort("usage")} style={{ minWidth: "150px" }} />
            <SortableTableHeader label={t("col_last_active")} active={sortField === "lastActive"} direction={sortDirection} icon={renderSortIcon("lastActive")} onSort={() => handleSort("lastActive")} />
            {canEditSubscribers && <th className="actions-col">{t("col_actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {paginatedSubscribers.map((sub: any) => {
             const uRatio = sub.traffic?.total ? (sub.traffic.used / sub.traffic.total) * 100 : 0;
             const isSelected = selectedImsis.includes(sub.imsi);
             return (
               <tr key={sub.imsi} className={isSelected ? "selected-row" : ""}>
                 <td className="mobile-select-cell">
                   <input type="checkbox" className="checkbox-custom" aria-label={t("table_select_subscriber", { imsi: sub.imsi })} checked={isSelected} onChange={() => setSelectedImsis((prev: string[]) => prev.includes(sub.imsi) ? prev.filter(i => i !== sub.imsi) : [...prev, sub.imsi])} />
                 </td>
                 <td data-label={t("col_status")}>
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
                 <td data-label={t("col_imsi")}>
                   <div className="imsi-text-container">
                     <span className="imsi-text">{sub.imsi}</span>
                     <button
                       type="button"
                       className={copiedImsi === sub.imsi ? "copy-btn copied" : "copy-btn"}
                       onClick={(event) => handleCopyImsi(sub.imsi, event)}
                       title={t("sub_copy_imsi")}
                       aria-label={`${t("sub_copy_imsi")}: ${sub.imsi}`}
                     >
                       {copiedImsi === sub.imsi ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                     </button>
                   </div>
                 </td>
                 <td data-label={t("col_plmn")}>
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
                  <td data-label={t("col_policy")}>
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
                 <td data-label={t("col_traffic")}>
                   <div className="traffic-container">
                      <div className="traffic-stats">
                        <span>{formatBytes(sub.traffic?.used || 0)}</span>
                        <span>{formatBytes(sub.traffic?.total || 1)}</span>
                      </div>
                      <div className="traffic-bar-container">
                        <div
                          className={`traffic-bar ${uRatio > 90 ? "high" : uRatio > 70 ? "medium" : "low"}`}
                          style={{ "--traffic-scale": Math.min(uRatio, 100) / 100 } as React.CSSProperties}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="last-active-cell" data-label={t("col_last_active")}>
                    <span title={formatFullDate(sub.lastActive)} className="last-active-text">
                      {timeAgo(sub.lastActive)}
                    </span>
                  </td>
                  {canEditSubscribers && (
                    <td className="actions-cell" data-label={t("col_actions")}>
                      <div className="actions-group">
                       <button type="button" className="action-btn action-btn-primary" onClick={(e) => { e.stopPropagation(); handleOpenEdit(sub.imsi); }} title={t("action_edit")} aria-label={`${t("action_edit")}: ${sub.imsi}`}>
                         <PenLine size={18} />
                       </button>
                       <button type="button" className="action-btn action-btn-danger" onClick={(e) => handleDelete(sub.imsi, e)} title={t("action_delete")} aria-label={`${t("action_delete")}: ${sub.imsi}`} disabled={isDeletingSingle === sub.imsi || Boolean(pendingDelete)}>
                         {isDeletingSingle === sub.imsi ? <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /> : <Trash2 size={18} />}
                       </button>
                       <div className="dropdown-container">
                         <button type="button" className="action-btn action-btn-muted" title={t("action_more")} aria-label={`${t("action_more")}: ${sub.imsi}`} aria-expanded={activeDropdown === sub.imsi} onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === sub.imsi ? null : sub.imsi); }}>
                           <MoreHorizontal size={18} />
                         </button>
                         {activeDropdown === sub.imsi && (
                           <>
                             <div className="dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setActiveDropdown(null); }} />
                             <div className="dropdown-menu">
                               <button className="dropdown-menu-item" onClick={(e) => {e.stopPropagation(); setActiveDropdown(null); setTraceImsi(sub.imsi);}}>{t("action_trace")}</button>
                               <button className="dropdown-menu-item" onClick={(e) => handleOpenTrafficAdjustment(sub, "recharge", e)}>{t("traffic_adjust")}</button>
                               <button className="dropdown-menu-item" onClick={(e) => handleOpenTrafficAdjustment(sub, "reset", e)}>{t("action_reset")}</button>
                             </div>
                           </>
                         )}
                       </div>
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
