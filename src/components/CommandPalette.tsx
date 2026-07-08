"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ElementType, KeyboardEvent } from "react";
import {
  Search, Users, CreditCard, Gauge, Activity, History, Key,
  LayoutDashboard, Plus, Download, FileUp, Zap, Command
} from "lucide-react";
import { useI18n } from "@/components/I18nProvider";

type PaletteItem = {
  id: string;
  label: string;
  desc: string;
  icon: ElementType;
  type: "navigation" | "action" | "imsi" | "profile";
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
  const { t } = useI18n();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
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
  }

  const navItems: PaletteItem[] = [
    { id: "nav-dashboard", label: t("cp_nav_dashboard"), desc: t("cp_nav_dashboard_desc"), icon: LayoutDashboard, path: "/", type: "navigation" },
    { id: "nav-subscribers", label: t("cp_nav_subscribers"), desc: t("cp_nav_subscribers_desc"), icon: Users, path: "/subscribers", type: "navigation" },
    { id: "nav-profile", label: t("cp_nav_profiles"), desc: t("cp_nav_profiles_desc"), icon: CreditCard, path: "/profile", type: "navigation" },
    { id: "nav-rating", label: t("cp_nav_rating"), desc: t("cp_nav_rating_desc"), icon: Gauge, path: "/rating", type: "navigation" },
    { id: "nav-account", label: t("cp_nav_account"), desc: t("cp_nav_account_desc"), icon: Key, path: "/account", type: "navigation" },
    { id: "nav-health", label: t("cp_nav_health"), desc: t("cp_nav_health_desc"), icon: Activity, path: "/system-health", type: "navigation" },
    { id: "nav-audit", label: t("cp_nav_audit"), desc: t("cp_nav_audit_desc"), icon: History, path: "/audit-logs", type: "navigation" },
  ];

  const actionItems: PaletteItem[] = [
    { id: "act-new-sub", label: t("cp_act_new_sub"), desc: t("cp_act_new_sub_desc"), icon: Plus, type: "action", actionKey: "new-subscriber" },
    { id: "act-import", label: t("cp_act_import"), desc: t("cp_act_import_desc"), icon: FileUp, type: "action", actionKey: "import-csv" },
    { id: "act-export", label: t("cp_act_export"), desc: t("cp_act_export_desc"), icon: Download, type: "action", actionKey: "export-csv" },
    { id: "act-sync", label: t("cp_act_sync"), desc: t("cp_act_sync_desc"), icon: Zap, type: "action", actionKey: "sync-telemetry" },
  ];

  useEffect(() => {
    if (!isOpen) return;
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [isOpen]);

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

        const data = await response.json() as { results?: ApiSearchItem[] };
        const results = (data.results || []).map((item) => ({
          ...item,
          icon: item.type === "imsi" ? Users : CreditCard,
          desc: item.type === "imsi" ? t("cp_search_open_sub") : t("cp_search_open_prof"),
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
    const results: PaletteItem[] = [];

    actionItems.forEach((item) => {
      if (!q || item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)) {
        results.push(item);
      }
    });

    navItems.forEach((item) => {
      if (!q || item.label.toLowerCase().includes(q) || item.desc.toLowerCase().includes(q)) {
        results.push(item);
      }
    });

    if (q.length >= 2) {
      results.push(...remoteItems);
    }

    return results;
  })();

  const activeSelectedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));

  const handleSelect = useCallback((item: PaletteItem) => {
    onClose();
    if (item.type === "navigation" || item.type === "imsi" || item.type === "profile") {
      router.push(item.path || "/");
    } else if (item.type === "action" && item.actionKey) {
      if (onAction) {
        onAction(item.actionKey);
      } else if (item.actionKey === "sync-telemetry") {
        fetch("/api/analytics/init", { method: "POST" }).catch(() => {});
      } else if (item.actionKey === "new-subscriber" || item.actionKey === "import-csv" || item.actionKey === "export-csv") {
        router.push("/subscribers");
      }
    }
  }, [onAction, onClose, router]);

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
    } else if (e.key === "Escape") {
      onClose();
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
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "0.65rem 1.25rem",
          cursor: "pointer",
          background: selected ? "rgba(78, 115, 223, 0.1)" : "transparent",
          borderLeft: selected ? "2px solid #4e73df" : "2px solid transparent",
          transition: "all 0.1s"
        }}
      >
        <div style={{
          width: "32px",
          height: "32px",
          borderRadius: "8px",
          background: selected ? accent : "#f1f5f9",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 0.15s"
        }}>
          <Icon size={16} color={selected ? "white" : "var(--text-muted)"} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-main)", fontFamily: item.type === "imsi" ? "monospace" : undefined }}>{item.label}</div>
          <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{item.desc}</div>
        </div>
        {badge && (
          <span style={{
            fontSize: item.type === "navigation" ? "0.7rem" : "0.65rem",
            padding: item.type === "navigation" ? undefined : "0.15rem 0.4rem",
            background: item.type === "imsi" ? "#dbeafe" : item.type === "profile" ? "#fef3c7" : undefined,
            color: item.type === "imsi" ? "#3b82f6" : item.type === "profile" ? "#d97706" : "#cbd5e1",
            borderRadius: "4px",
            fontWeight: item.type === "navigation" ? undefined : 600
          }}>
            {badge}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        background: "rgba(0, 0, 0, 0.4)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "fadeIn 0.15s ease-out"
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          width: "620px",
          maxHeight: "480px",
          background: "rgba(255, 255, 255, 0.85)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderRadius: "16px",
          border: "1px solid rgba(255, 255, 255, 0.3)",
          boxShadow: "0 25px 50px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(255,255,255,0.1) inset",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          animation: "slideDown 0.2s ease-out"
        }}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: "1rem 1.25rem",
          borderBottom: "1px solid rgba(0,0,0,0.06)"
        }}>
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
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: "1.05rem",
              color: "var(--text-main)",
              fontWeight: 500
            }}
          />
          <kbd style={{
            padding: "0.15rem 0.5rem",
            background: "rgba(0,0,0,0.05)",
            borderRadius: "4px",
            fontSize: "0.75rem",
            color: "#94a3b8",
            fontFamily: "monospace",
            border: "1px solid rgba(0,0,0,0.08)"
          }}>ESC</kbd>
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: "0.5rem 0" }}>
          {actionResults.length > 0 && (
            <div>
              <div style={{ padding: "0.4rem 1.25rem", fontSize: "0.7rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("cp_group_actions")}</div>
              {actionResults.map((item) => renderRow(item, getGlobalIndex(), "#4e73df"))}
            </div>
          )}

          {navResults.length > 0 && (
            <div>
              <div style={{ padding: "0.6rem 1.25rem 0.4rem", fontSize: "0.7rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("cp_group_nav")}</div>
              {navResults.map((item) => renderRow(item, getGlobalIndex(), "#4e73df", t("cp_badge_navigate")))}
            </div>
          )}

          {searchResults.length > 0 && (
            <div>
              <div style={{ padding: "0.6rem 1.25rem 0.4rem", fontSize: "0.7rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("cp_group_search")}</div>
              {searchResults.map((item) => renderRow(item, getGlobalIndex(), "#1cc88a", item.type === "imsi" ? "IMSI" : "Profile"))}
            </div>
          )}

          {isSearching && searchResults.length === 0 && (
            <div style={{ padding: "1rem 1.25rem", color: "#94a3b8", fontSize: "0.85rem" }}>
              {t("cp_searching")}
            </div>
          )}

          {!isSearching && filteredItems.length === 0 && (
            <div style={{ padding: "2rem", textAlign: "center", color: "#94a3b8", fontSize: "0.9rem" }}>
              {t("cp_no_results").replace("{query}", query)}
            </div>
          )}
        </div>

        <div style={{
          padding: "0.6rem 1.25rem",
          borderTop: "1px solid rgba(0,0,0,0.06)",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          fontSize: "0.7rem",
          color: "#94a3b8"
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <kbd style={{ padding: "0.1rem 0.35rem", background: "rgba(0,0,0,0.05)", borderRadius: "3px", fontSize: "0.65rem", fontFamily: "monospace" }}>Up</kbd>
            <kbd style={{ padding: "0.1rem 0.35rem", background: "rgba(0,0,0,0.05)", borderRadius: "3px", fontSize: "0.65rem", fontFamily: "monospace" }}>Down</kbd>
            {t("cp_hint_navigate")}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
            <kbd style={{ padding: "0.1rem 0.35rem", background: "rgba(0,0,0,0.05)", borderRadius: "3px", fontSize: "0.65rem", fontFamily: "monospace" }}>Enter</kbd>
            {t("cp_hint_select")}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.3rem" }}>
            <Command size={11} /> Powered by xCloud
          </span>
        </div>
      </div>
    </div>
  );
}
