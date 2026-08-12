"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ElementType, KeyboardEvent } from "react";
import {
  Search,
  Users,
  CreditCard,
  Gauge,
  Activity,
  History,
  LayoutDashboard,
  Plus,
  Download,
  FileUp,
  Zap,
  Command,
  GitBranch,
  Languages,
  UserCog,
  ShieldCheck,
  Wallet,
  Radio,
  Receipt,
  SunMoon,
  Trash2,
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";
import { useTheme } from "@/components/ThemeProvider";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import "./CommandPalette.css";

type PaletteItem = {
  id: string;
  label: string;
  desc: string;
  icon: ElementType;
  type: "navigation" | "action" | "imsi" | "profile";
  category?: "pages" | "actions" | "data";
  path?: string;
  actionKey?: string;
};

type ApiSearchItem = {
  id: string;
  label: string;
  desc: string;
  type: "imsi" | "profile";
  path: string;
};

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onAction?: (actionKey: string) => void;
}

const REMOTE_SEARCH_DELAY_MS = 250;

export default function CommandPalette({ isOpen, onClose, onAction }: CommandPaletteProps) {
  const { t, lang, setLang } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus({ open: isOpen, onClose, initialFocusRef: inputRef });

  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<"all" | "pages" | "actions" | "data">("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [remoteItems, setRemoteItems] = useState<PaletteItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [wasOpen, setWasOpen] = useState(isOpen);

  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (query) setQuery("");
    if (remoteItems.length > 0) setRemoteItems([]);
    if (selectedIndex !== 0) setSelectedIndex(0);
    if (isSearching) setIsSearching(false);
    if (activeCategory !== "all") setActiveCategory("all");
  }

  const navItems: PaletteItem[] = [
    { id: "nav-dashboard", label: t("cp_nav_dashboard"), desc: t("cp_nav_dashboard_desc"), icon: LayoutDashboard, path: "/", type: "navigation", category: "pages" },
    { id: "nav-subscribers", label: t("cp_nav_subscribers"), desc: t("cp_nav_subscribers_desc"), icon: Users, path: "/subscribers", type: "navigation", category: "pages" },
    { id: "nav-ocs-balances", label: t("nav_ocs_balances"), desc: t("ocs_balances_desc") || t("cp_nav_dashboard_desc"), icon: Wallet, path: "/ocs/balances", type: "navigation", category: "pages" },
    { id: "nav-ocs-sessions", label: t("nav_ocs_sessions"), desc: t("ocs_sessions_desc") || t("cp_nav_dashboard_desc"), icon: Radio, path: "/ocs/sessions", type: "navigation", category: "pages" },
    { id: "nav-ocs-usage", label: t("nav_ocs_usage"), desc: t("ocs_usage_desc") || t("cp_nav_dashboard_desc"), icon: Receipt, path: "/ocs/usage", type: "navigation", category: "pages" },
    { id: "nav-profile", label: t("cp_nav_profiles"), desc: t("cp_nav_profiles_desc"), icon: CreditCard, path: "/profile", type: "navigation", category: "pages" },
    { id: "nav-rating-plans", label: t("cp_nav_rating_plans"), desc: t("cp_nav_rating_plans_desc"), icon: Gauge, path: "/rating/plans", type: "navigation", category: "pages" },
    { id: "nav-rating-rules", label: t("cp_nav_rating_rules"), desc: t("cp_nav_rating_rules_desc"), icon: GitBranch, path: "/rating/rules", type: "navigation", category: "pages" },
    { id: "nav-users", label: t("nav_system_users"), desc: t("users_mgmt_desc") || t("cp_nav_account_desc"), icon: UserCog, path: "/users", type: "navigation", category: "pages" },
    { id: "nav-roles", label: t("nav_roles"), desc: t("roles_matrix_desc") || t("cp_nav_account_desc"), icon: ShieldCheck, path: "/roles", type: "navigation", category: "pages" },
    { id: "nav-approvals", label: t("nav_approvals"), desc: t("approvals_center_desc") || t("cp_nav_account_desc"), icon: GitBranch, path: "/approvals", type: "navigation", category: "pages" },
    { id: "nav-audit", label: t("cp_nav_audit"), desc: t("cp_nav_audit_desc"), icon: History, path: "/audit-logs", type: "navigation", category: "pages" },
    { id: "nav-health", label: t("cp_nav_health"), desc: t("cp_nav_health_desc"), icon: Activity, path: "/system-health", type: "navigation", category: "pages" },
  ];

  const actionItems: PaletteItem[] = [
    { id: "act-new-sub", label: t("cp_act_new_sub"), desc: t("cp_act_new_sub_desc"), icon: Plus, type: "action", category: "actions", actionKey: "new-subscriber" },
    { id: "act-import", label: t("cp_act_import"), desc: t("cp_act_import_desc"), icon: FileUp, type: "action", category: "actions", actionKey: "import-csv" },
    { id: "act-export", label: t("cp_act_export"), desc: t("cp_act_export_desc"), icon: Download, type: "action", category: "actions", actionKey: "export-csv" },
    { id: "act-sync", label: t("cp_act_sync"), desc: t("cp_act_sync_desc"), icon: Zap, type: "action", category: "actions", actionKey: "sync-telemetry" },
    {
      id: "act-toggle-theme",
      label: theme === "dark" ? t("theme_switch_light") : t("theme_switch_dark"),
      desc: t("cp_act_theme_desc"),
      icon: SunMoon,
      type: "action",
      category: "actions",
      actionKey: "toggle-theme",
    },
    {
      id: "act-switch-lang",
      label: lang === "en" ? t("cp_lang_zh") : t("cp_lang_en"),
      desc: lang === "en" ? t("cp_lang_zh_desc") : t("cp_lang_en_desc"),
      icon: Languages,
      type: "action",
      category: "actions",
      actionKey: "toggle-language",
    },
    {
      id: "act-clear-history",
      label: t("nav_crumb_clear_recent"),
      desc: t("cp_act_clear_history_desc"),
      icon: Trash2,
      type: "action",
      category: "actions",
      actionKey: "clear-recent-history",
    },
  ];

  useEffect(() => {
    const trimmed = query.trim();

    if (!isOpen || trimmed.length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=8`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Search failed: ${response.status}`);

        const data = (await response.json()) as { results?: ApiSearchItem[] };
        const results = (data.results || []).map((item) => ({
          ...item,
          icon: item.type === "imsi" ? Users : CreditCard,
          desc: item.type === "imsi" ? t("cp_search_open_sub") : t("cp_search_open_prof"),
          category: "data" as const,
        }));
        setRemoteItems(results);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Command palette search failed:", error);
          setRemoteItems([]);
        }
      } finally {
        if (!controller.signal.aborted) setIsSearching(false);
      }
    }, REMOTE_SEARCH_DELAY_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [isOpen, query, t]);

  const filteredItems: PaletteItem[] = (() => {
    const q = query.toLowerCase().trim();
    const candidates: PaletteItem[] = [];

    if (activeCategory === "all" || activeCategory === "actions") {
      actionItems.forEach((item) => {
        if (!q || item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)) {
          candidates.push(item);
        }
      });
    }

    if (activeCategory === "all" || activeCategory === "pages") {
      navItems.forEach((item) => {
        if (!q || item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)) {
          candidates.push(item);
        }
      });
    }

    if ((activeCategory === "all" || activeCategory === "data") && q.length >= 2) {
      candidates.push(...remoteItems);
    }

    return candidates;
  })();

  const activeSelectedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      onClose();
      if (item.type === "navigation" || item.type === "imsi" || item.type === "profile") {
        router.push(item.path || "/");
      } else if (item.type === "action" && item.actionKey) {
        if (item.actionKey === "toggle-language") {
          setLang(lang === "en" ? "zh" : "en");
        } else if (item.actionKey === "toggle-theme") {
          toggleTheme();
        } else if (item.actionKey === "clear-recent-history") {
          try {
            localStorage.removeItem("XCLOUD_RECENT_PAGES");
          } catch {}
        } else if (onAction) {
          onAction(item.actionKey);
        } else if (item.actionKey === "sync-telemetry") {
          fetch("/api/analytics/init", { method: "POST" }).catch(() => {});
        } else if (
          item.actionKey === "new-subscriber" ||
          item.actionKey === "import-csv" ||
          item.actionKey === "export-csv"
        ) {
          router.push("/subscribers");
        }
      }
    },
    [onAction, onClose, router, lang, setLang, toggleTheme]
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, Math.max(0, filteredItems.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filteredItems[activeSelectedIndex]) {
        handleSelect(filteredItems[activeSelectedIndex]);
      }
    }
  };

  if (!isOpen) return null;

  const actionResults = filteredItems.filter((item) => item.type === "action");
  const navResults = filteredItems.filter((item) => item.type === "navigation");
  const searchResults = filteredItems.filter((item) => item.type === "imsi" || item.type === "profile");

  let globalIdx = 0;
  const getGlobalIndex = () => globalIdx++;

  const renderRow = (item: PaletteItem, idx: number, accent: string, badge?: string) => {
    const Icon = item.icon;
    const selected = activeSelectedIndex === idx;

    return (
      <div
        key={item.id}
        onClick={() => handleSelect(item)}
        onMouseEnter={() => setSelectedIndex(idx)}
        className={`cp-item-row ${selected ? "cp-item-row-selected" : ""}`}
      >
        <div className="cp-item-icon-box" style={{ background: selected ? accent : "var(--surface-hover)" }}>
          <Icon size={16} color={selected ? "white" : "var(--text-muted)"} />
        </div>
        <div className="cp-item-content">
          <div className={`cp-item-label ${item.type === "imsi" ? "cp-item-label-mono" : ""}`}>{item.label}</div>
          <div className="cp-item-desc">{item.desc}</div>
        </div>
        {badge && (
          <span className={`cp-item-badge cp-badge-${item.type === "navigation" ? "nav" : item.type}`}>
            {badge}
          </span>
        )}
      </div>
    );
  };

  return (
    <div onClick={onClose} className="cp-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("cp_title")}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="cp-modal"
      >
        <div className="cp-search-header">
          <Search size={20} color="#94a3b8" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              const nextQuery = e.target.value;
              setQuery(nextQuery);
              setSelectedIndex(0);
              if (nextQuery.trim().length < 2) {
                setRemoteItems([]);
                setIsSearching(false);
              }
            }}
            placeholder={t("cp_placeholder")}
            aria-label={t("cp_placeholder")}
            className="cp-search-input"
          />
          <kbd className="cp-kbd-shortcut">ESC</kbd>
        </div>

        {/* Category Filter Tabs */}
        <div className="cp-category-tabs">
          <button
            type="button"
            className={`cp-category-tab ${activeCategory === "all" ? "active" : ""}`}
            onClick={() => setActiveCategory("all")}
          >
            {t("cp_cat_all")}
          </button>
          <button
            type="button"
            className={`cp-category-tab ${activeCategory === "pages" ? "active" : ""}`}
            onClick={() => setActiveCategory("pages")}
          >
            {t("cp_cat_pages")}
          </button>
          <button
            type="button"
            className={`cp-category-tab ${activeCategory === "actions" ? "active" : ""}`}
            onClick={() => setActiveCategory("actions")}
          >
            {t("cp_cat_actions")}
          </button>
          <button
            type="button"
            className={`cp-category-tab ${activeCategory === "data" ? "active" : ""}`}
            onClick={() => setActiveCategory("data")}
          >
            {t("cp_cat_data")}
          </button>
        </div>

        <div className="cp-results-container">
          {actionResults.length > 0 && (
            <div>
              <div className="cp-group-header">{t("cp_group_actions")}</div>
              {actionResults.map((item) => renderRow(item, getGlobalIndex(), "#4e73df"))}
            </div>
          )}

          {navResults.length > 0 && (
            <div>
              <div className="cp-group-header-mt">{t("cp_group_nav")}</div>
              {navResults.map((item) => renderRow(item, getGlobalIndex(), "#4e73df", t("cp_badge_navigate")))}
            </div>
          )}

          {searchResults.length > 0 && (
            <div>
              <div className="cp-group-header-mt">{t("cp_group_search")}</div>
              {searchResults.map((item) =>
                renderRow(item, getGlobalIndex(), "#1cc88a", item.type === "imsi" ? "IMSI" : "Profile")
              )}
            </div>
          )}

          {isSearching && searchResults.length === 0 && (
            <div className="cp-status-msg">{t("cp_searching")}</div>
          )}

          {!isSearching && filteredItems.length === 0 && (
            <div className="cp-no-results">{t("cp_no_results").replace("{query}", query)}</div>
          )}
        </div>

        <div className="cp-footer">
          <span className="cp-footer-hint">
            <kbd className="cp-kbd-small">↑</kbd>
            <kbd className="cp-kbd-small">↓</kbd>
            {t("cp_hint_navigate")}
          </span>
          <span className="cp-footer-hint">
            <kbd className="cp-kbd-small">↵</kbd>
            {t("cp_hint_select")}
          </span>
          <span className="cp-footer-branding">
            <Command size={11} /> Powered by xCloud
          </span>
        </div>
      </div>
    </div>
  );
}
