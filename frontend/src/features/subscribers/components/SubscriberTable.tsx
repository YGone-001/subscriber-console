/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/subscribers/components/SubscriberTable.tsx
 * Adaptations: the row now separates access state from the OCS contract and
 * provisioning state, shows the MSISDN, and routes destructive actions through
 * the overflow menu.
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Users, CheckCircle2, Copy, Eye, Trash2, MoreHorizontal, BatteryCharging, AlertTriangle, ExternalLink, Boxes } from "lucide-react";
import { useI18n } from '../../../providers/I18nProvider';
import { EmptyState, LoadingRows } from '../../../components/ui/OperationFeedback';
import { SortableTableHeader } from '../../../components/ui/SortableTableHeader';
import { useAppRouter } from '../../../lib/ui-compat/router';
import { formatBytes } from '../../../lib/unitParser';
import { resolveTemplateBinding } from '../subscriber-template-binding';
import type { SubscriberRow } from '../types';

const ACTION_MENU_WIDTH = 180;
const ACTION_MENU_HEIGHT = 172;
const ACTION_MENU_GAP = 6;
const ACTION_MENU_VIEWPORT_MARGIN = 8;

type ActionMenuPosition = {
  top: number;
  left: number;
  placement: "top" | "bottom";
};

type TriggerRect = Pick<DOMRect, "top" | "right" | "bottom">;

export function getSubscriberActionMenuPosition(
  rect: TriggerRect,
  viewportWidth: number,
  viewportHeight: number,
): ActionMenuPosition {
  const maxLeft = Math.max(ACTION_MENU_VIEWPORT_MARGIN, viewportWidth - ACTION_MENU_WIDTH - ACTION_MENU_VIEWPORT_MARGIN);
  const left = Math.max(ACTION_MENU_VIEWPORT_MARGIN, Math.min(rect.right - ACTION_MENU_WIDTH, maxLeft));
  const belowTop = rect.bottom + ACTION_MENU_GAP;
  const aboveTop = rect.top - ACTION_MENU_GAP - ACTION_MENU_HEIGHT;
  const fitsBelow = belowTop + ACTION_MENU_HEIGHT <= viewportHeight - ACTION_MENU_VIEWPORT_MARGIN;
  const fitsAbove = aboveTop >= ACTION_MENU_VIEWPORT_MARGIN;

  if (!fitsBelow && fitsAbove) {
    return { top: aboveTop, left, placement: "top" };
  }

  const maxTop = Math.max(ACTION_MENU_VIEWPORT_MARGIN, viewportHeight - ACTION_MENU_HEIGHT - ACTION_MENU_VIEWPORT_MARGIN);
  return {
    top: Math.max(ACTION_MENU_VIEWPORT_MARGIN, Math.min(belowTop, maxTop)),
    left,
    placement: "bottom",
  };
}

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
  handleOpenProfileApply: (sub: SubscriberRow) => void;
  /* The template catalog decides whether a binding still resolves. It is passed
   * down so a dangling binding is visible instead of rendering as a name. */
  profiles: Array<{ name: string; title?: string }>;
  profilesReady: boolean;
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
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const actionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [actionMenuPosition, setActionMenuPosition] = useState<ActionMenuPosition | null>(null);
  const {
    isLoading, totalSubscribers, searchQuery, hasActiveFilters, canEditSubscribers, canAdjustBalance,
    handleOpenNew, isAllPageSelected, selectedOnPageCount, pageImsis,
    toggleSelectAll, sortField, sortDirection, handleSort, renderSortIcon, paginatedSubscribers,
    selectedImsis, setSelectedImsis, copiedImsi, handleCopyImsi, resolveNetwork,
    formatFullDate, timeAgo, handleOpenView, handleDelete,
    isDeletingSingle, pendingDelete, activeDropdown, setActiveDropdown,
    handleOpenTrafficAdjustment, handleOpenProfileApply, profiles, profilesReady,
  } = props;

  useEffect(() => {
    if (!activeDropdown || !actionMenuPosition) return;

    const closeMenu = () => {
      setActiveDropdown(null);
      setActionMenuPosition(null);
    };
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (actionMenuRef.current?.contains(target) || actionMenuTriggerRef.current?.contains(target)) return;
      closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMenu();
      actionMenuTriggerRef.current?.focus();
    };
    const closeOnViewportChange = () => closeMenu();
    const focusFrame = window.requestAnimationFrame(() => {
      actionMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [activeDropdown, actionMenuPosition, setActiveDropdown]);

  const toggleActionMenu = (imsi: string, trigger: HTMLButtonElement) => {
    if (activeDropdown === imsi) {
      setActiveDropdown(null);
      setActionMenuPosition(null);
      return;
    }

    actionMenuTriggerRef.current = trigger;
    setActionMenuPosition(getSubscriberActionMenuPosition(
      trigger.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
    ));
    setActiveDropdown(imsi);
  };

  if (isLoading) {
    return <LoadingRows columns={canEditSubscribers ? 9 : 8} rows={5} />;
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
            <th data-column-priority="important">{t("sub_profile_column")}</th>
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
                      <button
                        type="button"
                        className="imsi-link"
                        onClick={() => handleOpenView(sub.imsi)}
                        title={t("sub_action_view")}
                        aria-label={`${t("sub_action_view")}: ${sub.imsi}`}
                      >
                        {sub.imsi}
                      </button>
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
                <td data-label={t("sub_profile_column")} data-column-priority="important">
                  {(() => {
                    const binding = resolveTemplateBinding(
                      typeof sub.profile === 'string' ? sub.profile : '',
                      profiles,
                      profilesReady,
                    );
                    if (binding.state === 'unbound') {
                      return <span className="no-policy">{t("sub_tpl_unbound")}</span>;
                    }
                    if (binding.state === 'pending') {
                      return <span className="policy-text">{binding.name}</span>;
                    }
                    if (binding.state === 'dangling') {
                      return (
                        <span className="provisioning-warning" title={t("sub_tpl_dangling_hint")}>
                          <AlertTriangle size={13} /> {t("sub_tpl_dangling")}
                        </span>
                      );
                    }
                    return (
                      <button
                        type="button"
                        className="imsi-link"
                        title={binding.name}
                        onClick={(event) => {
                          event.stopPropagation();
                          router.push(`/profile/${encodeURIComponent(binding.name)}`);
                        }}
                      >
                        {binding.template?.title || binding.name}
                      </button>
                    );
                  })()}
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
                        <button type="button" className="action-btn action-btn-muted" title={t("action_more")} aria-label={`${t("action_more")}: ${sub.imsi}`} aria-expanded={activeDropdown === sub.imsi} aria-haspopup="menu" aria-controls={activeDropdown === sub.imsi ? "subscriber-row-action-menu" : undefined} onClick={(e) => { e.stopPropagation(); toggleActionMenu(sub.imsi, e.currentTarget); }}>
                          <MoreHorizontal size={18} />
                        </button>
                        {activeDropdown === sub.imsi && actionMenuPosition && typeof document !== "undefined" && createPortal(
                            <div
                              id="subscriber-row-action-menu"
                              ref={actionMenuRef}
                              className="dropdown-menu dropdown-menu-portal"
                              role="menu"
                              aria-label={`${t("action_more")}: ${sub.imsi}`}
                              data-placement={actionMenuPosition.placement}
                              style={{ top: actionMenuPosition.top, left: actionMenuPosition.left }}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <button type="button" role="menuitem" className="dropdown-menu-item" onClick={() => { setActiveDropdown(null); setActionMenuPosition(null); router.push(`/ocs/contracts/${encodeURIComponent(sub.imsi)}`); }}>
                                <ExternalLink size={14} /> {t("sub_view_contract")}
                              </button>
                              <button type="button" role="menuitem" className="dropdown-menu-item" onClick={() => { setActiveDropdown(null); setActionMenuPosition(null); router.push(`/ocs/balances/${encodeURIComponent(sub.imsi)}`); }}>
                                <ExternalLink size={14} /> {t("sub_view_balance")}
                              </button>
                              <button type="button" role="menuitem" className="dropdown-menu-item" onClick={() => { setActiveDropdown(null); setActionMenuPosition(null); handleOpenProfileApply(sub); }}>
                                <Boxes size={14} /> {t("sub_apply_profile_action")}
                              </button>
                              <button type="button" role="menuitem" className="dropdown-menu-item danger" onClick={(event) => { setActionMenuPosition(null); handleDelete(sub.imsi, event); }} disabled={isDeletingSingle === sub.imsi || Boolean(pendingDelete)}>
                                <Trash2 size={14} /> {isDeletingSingle === sub.imsi ? t("deleting") : t("action_delete")}
                              </button>
                            </div>,
                            document.body,
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
