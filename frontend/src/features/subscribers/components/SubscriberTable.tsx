/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/subscribers/components/SubscriberTable.tsx
 * Adaptations: the row now separates access state from the OCS contract and
 * provisioning state, shows the MSISDN, and routes destructive actions through
 * the overflow menu.
 */
import React from "react";
import { Plus, Users, CheckCircle2, Copy, Eye, Trash2, MoreHorizontal, BatteryCharging, AlertTriangle, ExternalLink } from "lucide-react";
import { useI18n } from '../../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../../components/ui/OperationFeedback';
import { SortableTableHeader } from '../../../components/ui/SortableTableHeader';
import { useAppRouter } from '../../../lib/ui-compat/router';
import { formatBytes } from '../../../lib/unitParser';
import type { SubscriberRow } from '../types';

export interface SubscriberTableProps {
  isLoading: boolean;
  totalSubscribers: number;
  searchQuery: string;
  hasActiveFilters: boolean;
  canEditSubscribers: boolean;
  canAdjustBalance: boolean;
  handleOpenNew: () => void;
  isAllPageSelected: boolean;
  selectedOnPageCount: number;
  pageImsis: string[];
  toggleSelectAll: (e: React.ChangeEvent<HTMLInputElement>) => void;
  sortField: string;
  sortDirection: "asc" | "desc";
  handleSort: (field: string) => void;
  renderSortIcon: (field: string) => React.ReactNode;
  paginatedSubscribers: SubscriberRow[];
  selectedImsis: string[];
  setSelectedImsis: React.Dispatch<React.SetStateAction<string[]>>;
  copiedImsi: string | null;
  handleCopyImsi: (value: string, e?: React.MouseEvent) => void;
  resolveNetwork: (imsi: string) => { plmn: string; network?: string; country?: string; country_code?: string };
  formatFullDate: (value: string) => string;
  timeAgo: (value: string) => string;
  handleOpenView: (imsi: string) => void;
  handleDelete: (imsi: string, e?: React.MouseEvent) => void;
  isDeletingSingle: string | null;
  pendingDelete: unknown;
  activeDropdown: string | null;
  setActiveDropdown: React.Dispatch<React.SetStateAction<string | null>>;
  handleOpenTrafficAdjustment: (sub: SubscriberRow, e?: React.MouseEvent) => void;
}

function contractStatusLabel(t: (key: string, params?: Record<string, string | number>) => string, value?: string) {
  if (!value) return t("sub_not_configured");
  if (value === "active") return t("status_active");
  if (value === "suspended") return t("status_suspended");
  if (value === "terminated") return t("ocs_contract_status_terminated");
  return value;
}

function provisioningLabel(t: (key: string, params?: Record<string, string | number>) => string, row: SubscriberRow) {
  const provisioning = row.provisioning;
  if (!provisioning) return t("sub_not_configured");
  if (provisioning.contract && provisioning.balance && provisioning.tariffPlan) return "";
  const missing: string[] = [];
  if (!provisioning.contract) missing.push(t("sub_provisioning_missing_contract"));
  if (!provisioning.balance) missing.push(t("sub_provisioning_missing_balance"));
  if (!provisioning.tariffPlan) missing.push(t("sub_provisioning_missing_plan"));
  return missing.join(" · ");
}

export function SubscriberTable(props: SubscriberTableProps) {
  const { t } = useI18n();
  const router = useAppRouter();
  const {
    isLoading, totalSubscribers, searchQuery, hasActiveFilters, canEditSubscribers, canAdjustBalance,
    handleOpenNew, isAllPageSelected, selectedOnPageCount, pageImsis,
    toggleSelectAll, sortField, sortDirection, handleSort, renderSortIcon, paginatedSubscribers,
    selectedImsis, setSelectedImsis, copiedImsi, handleCopyImsi, resolveNetwork,
    formatFullDate, timeAgo, handleOpenView, handleDelete,
    isDeletingSingle, pendingDelete, activeDropdown, setActiveDropdown,
    handleOpenTrafficAdjustment,
  } = props;

  if (isLoading) {
    return <LoadingRows columns={canEditSubscribers ? 8 : 7} rows={5} />;
  }

  if (totalSubscribers === 0) {
    return (
      <EmptyState
        icon={<Users size={48} />}
        title={searchQuery || hasActiveFilters ? t("no_subscribers_search") : t("no_subscribers_empty")}
        description={searchQuery || hasActiveFilters ? t("sub_empty_search_desc") : t("sub_empty_create_desc")}
        action={
          canEditSubscribers && !searchQuery && !hasActiveFilters ? (
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
        <caption className="sr-only">{t("subscriber_title")}</caption>
        <thead>
          <tr>
            <th data-column-priority="essential">
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
            <SortableTableHeader label={t("subscriber_user_column")} active={sortField === "imsi"} direction={sortDirection} icon={renderSortIcon("imsi")} onSort={() => handleSort("imsi")} />
            <th data-column-priority="important">{t("sub_contract_status")}</th>
            <SortableTableHeader priority="important" label={t("col_policy")} active={sortField === "policy"} direction={sortDirection} icon={renderSortIcon("policy")} onSort={() => handleSort("policy")} />
            <SortableTableHeader label={t("col_traffic")} active={sortField === "usage"} direction={sortDirection} icon={renderSortIcon("usage")} onSort={() => handleSort("usage")} className="usage-column" />
            <SortableTableHeader priority="important" label={t("col_last_active")} active={sortField === "lastActive"} direction={sortDirection} icon={renderSortIcon("lastActive")} onSort={() => handleSort("lastActive")} />
            {canEditSubscribers && <th className="actions-col" data-column-priority="essential">{t("col_actions")}</th>}
          </tr>
        </thead>
        <tbody>
          {paginatedSubscribers.map((sub) => {
            const traffic = sub.traffic;
            const hasBalance = Boolean(sub.provisioning?.balance);
            const total = traffic?.total || 0;
            const used = traffic?.used || 0;
            const balance = traffic?.balance ?? Math.max(0, total - used);
            const uRatio = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
            const remainingPercent = total > 0 ? Math.max(0, Math.min(100, (balance / total) * 100)) : (hasBalance ? 0 : null);
            const balanceState = sub.balanceState ?? (hasBalance
              ? (balance <= 0 ? "exhausted" : (sub.balanceThreshold && balance <= sub.balanceThreshold ? "low" : "normal"))
              : "missing");
            const balanceStateLabel = balanceState === "low"
              ? t("sub_balance_low")
              : balanceState === "exhausted"
                ? t("sub_balance_exhausted_short")
                : "";
            const isSelected = selectedImsis.includes(sub.imsi);
            const net = resolveNetwork(sub.imsi);
            const networkTooltip = net.network && net.network !== 'Unknown'
              ? `${net.network} - ${net.country}${net.country_code ? ' (+' + net.country_code + ')' : ''}`
              : t("unknown_network");
            const provisioningWarning = provisioningLabel(t, sub);
            const isContractActive = sub.contractStatus === "active";

            return (
              <tr key={sub.imsi} className={isSelected ? "selected-row" : ""}>
                <td className="mobile-select-cell" data-column-priority="essential">
                  <input type="checkbox" className="checkbox-custom" aria-label={t("table_select_subscriber", { imsi: sub.imsi })} checked={isSelected} onChange={() => setSelectedImsis((prev) => prev.includes(sub.imsi) ? prev.filter(i => i !== sub.imsi) : [...prev, sub.imsi])} />
                </td>
                <td data-label={t("col_status")} data-column-priority="essential">
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
                <td data-label={t("subscriber_user_column")} data-column-priority="essential">
                  <div className="subscriber-identity-cell">
                    <div className="imsi-text-container">
                      <button type="button" className="imsi-link" onClick={() => handleOpenView(sub.imsi)}>{sub.imsi}</button>
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
                    <div className="subscriber-secondary-line">
                      {sub.msisdn ? (
                        <>
                          <span className="subscriber-msisdn">{sub.msisdn}</span>
                          <button
                            type="button"
                            className={copiedImsi === sub.msisdn ? "copy-btn copied" : "copy-btn"}
                            onClick={(event) => handleCopyImsi(sub.msisdn || "", event)}
                            title={t("sub_copy_msisdn")}
                            aria-label={`${t("sub_copy_msisdn")}: ${sub.msisdn}`}
                          >
                            {copiedImsi === sub.msisdn ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                          </button>
                        </>
                      ) : (
                        <span className="subscriber-msisdn muted">{t("sub_no_msisdn")}</span>
                      )}
                      <span className="plmn-badge" title={networkTooltip}>{net.plmn}</span>
                    </div>
                  </div>
                </td>
                <td data-label={t("sub_contract_status")} data-column-priority="important">
                  <div className="contract-status-cell">
                    <span className={`status-badge ${isContractActive ? "active" : sub.contractStatus ? "suspended" : "partial"}`}>
                      {contractStatusLabel(t, sub.contractStatus)}
                    </span>
                    {provisioningWarning && (
                      <span className="provisioning-warning" title={provisioningWarning}>
                        <AlertTriangle size={13} /> {t("sub_provisioning_incomplete")}
                      </span>
                    )}
                  </div>
                </td>
                <td data-label={t("col_policy")} data-column-priority="important">
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
                    <span className="no-policy">{t("sub_not_configured")}</span>
                  )}
                </td>
                <td data-label={t("col_traffic")} data-column-priority="essential">
                  {hasBalance ? (
                    <div className="traffic-container">
                      <div className="traffic-stats">
                        <span>{formatBytes(balance)}</span>
                        <span>{formatBytes(total)}</span>
                        <span className="traffic-percent">{remainingPercent === null ? t("sub_not_configured") : `${remainingPercent.toFixed(0)}%`}</span>
                      </div>
                      {balanceStateLabel && (
                        <div
                          className={`traffic-state traffic-state-${balanceState}`}
                          title={sub.balanceThreshold && sub.balanceThreshold > 0
                            ? t("sub_balance_threshold_tooltip", { threshold: formatBytes(sub.balanceThreshold) })
                            : undefined}
                        >
                          {balanceStateLabel}
                        </div>
                      )}
                      <div className="traffic-bar-container">
                        <div
                          className={`traffic-bar ${uRatio > 90 ? "high" : uRatio > 70 ? "medium" : "low"}`}
                          style={{ "--traffic-scale": Math.min(uRatio, 100) / 100 } as React.CSSProperties}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="no-policy">{t("sub_not_configured")}</span>
                  )}
                </td>
                <td className="last-active-cell" data-label={t("col_last_active")} data-column-priority="important">
                  <span title={formatFullDate(sub.lastActive)} className="last-active-text">
                    {timeAgo(sub.lastActive)}
                  </span>
                </td>
                {canEditSubscribers && (
                  <td className="actions-cell" data-label={t("col_actions")} data-column-priority="essential">
                    <div className="actions-group">
                      <button type="button" className="action-btn action-btn-primary" onClick={(e) => { e.stopPropagation(); handleOpenView(sub.imsi); }} title={t("sub_action_view")} aria-label={`${t("sub_action_view")}: ${sub.imsi}`}>
                        <Eye size={18} />
                      </button>
                      {canAdjustBalance && hasBalance && (
                        <button type="button" className="action-btn action-btn-primary" onClick={(e) => handleOpenTrafficAdjustment(sub, e)} title={t("traffic_adjust")} aria-label={`${t("traffic_adjust")}: ${sub.imsi}`}>
                          <BatteryCharging size={18} />
                        </button>
                      )}
                      <div className="dropdown-container">
                        <button type="button" className="action-btn action-btn-muted" title={t("action_more")} aria-label={`${t("action_more")}: ${sub.imsi}`} aria-expanded={activeDropdown === sub.imsi} onClick={(e) => { e.stopPropagation(); setActiveDropdown(activeDropdown === sub.imsi ? null : sub.imsi); }}>
                          <MoreHorizontal size={18} />
                        </button>
                        {activeDropdown === sub.imsi && (
                          <>
                            <div className="dropdown-backdrop" onClick={(e) => { e.stopPropagation(); setActiveDropdown(null); }} />
                            <div className="dropdown-menu">
                              <button className="dropdown-menu-item" onClick={() => { setActiveDropdown(null); router.push(`/ocs/contracts/${encodeURIComponent(sub.imsi)}`); }}>
                                <ExternalLink size={14} /> {t("sub_view_contract")}
                              </button>
                              <button className="dropdown-menu-item" onClick={() => { setActiveDropdown(null); router.push(`/ocs/balances/${encodeURIComponent(sub.imsi)}`); }}>
                                <ExternalLink size={14} /> {t("sub_view_balance")}
                              </button>
                              <button className="dropdown-menu-item danger" onClick={(event) => handleDelete(sub.imsi, event)} disabled={isDeletingSingle === sub.imsi || Boolean(pendingDelete)}>
                                <Trash2 size={14} /> {isDeletingSingle === sub.imsi ? t("deleting") : t("action_delete")}
                              </button>
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
