import { AlertTriangle, CheckCircle2, Database, ExternalLink, MessageSquare, Mic2, ShieldCheck } from "lucide-react";
import type React from "react";
import { formatBytes, formatEvents, formatSeconds } from "@/lib/unitParser";
import "./rating-rule-link-panel.css";

type RatingRule = {
  rating_group_id?: number;
  rating_group?: number;
  rule_id?: string;
  apn?: string;
  service_identifier?: number;
  charging_type?: string;
  unit?: string;
  quota_per_grant?: number;
  validity_time?: number;
  volume_threshold?: number;
  currency?: string;
  rates?: string | number;
  rates_type?: number;
  status?: string;
};

type ScenarioKey = "data" | "ims" | "voice" | "sms";

type Scenario = {
  key: ScenarioKey;
  labelKey: string;
  descriptionKey: string;
  icon: React.ReactNode;
  match: (rule: RatingRule) => boolean;
};

type Translator = (key: string, params?: Record<string, string | number>) => string;

const scenarios: Scenario[] = [
  {
    key: "data",
    labelKey: "rating_service_data",
    descriptionKey: "rating_service_data_desc",
    icon: <Database size={16} />,
    match: (rule) => rule.charging_type === "data_volume" && (rule.apn || "internet") !== "ims",
  },
  {
    key: "ims",
    labelKey: "rating_service_ims",
    descriptionKey: "rating_service_ims_desc",
    icon: <ShieldCheck size={16} />,
    match: (rule) => (rule.apn || "").toLowerCase() === "ims" && rule.charging_type === "free",
  },
  {
    key: "voice",
    labelKey: "rating_service_voice",
    descriptionKey: "rating_service_voice_desc",
    icon: <Mic2 size={16} />,
    match: (rule) => rule.charging_type === "voice_time",
  },
  {
    key: "sms",
    labelKey: "rating_service_sms",
    descriptionKey: "rating_service_sms_desc",
    icon: <MessageSquare size={16} />,
    match: (rule) => rule.charging_type === "sms_event" || rule.unit === "events",
  },
];

function ratingGroup(rule: RatingRule) {
  return Number(rule.rating_group_id ?? rule.rating_group ?? 0);
}

function formatGrant(rule: RatingRule | undefined, t: Translator) {
  if (!rule) return "-";
  const grant = Number(rule.quota_per_grant ?? 0);
  if (rule.charging_type === "free" || grant <= 0) return t("rating_grant_included");
  if (rule.charging_type === "voice_time" || rule.unit === "seconds") return formatSeconds(grant);
  if (rule.charging_type === "sms_event" || rule.unit === "events") return formatEvents(grant);
  return formatBytes(grant);
}

function statusText(found: boolean, inCatalog: boolean | null, t: Translator) {
  if (!found) return t("rating_link_status_missing");
  if (inCatalog === false) return t("rating_link_status_plan_only");
  return t("rating_link_status_linked");
}

function statusColor(found: boolean, inCatalog: boolean | null) {
  if (!found) return "var(--danger)";
  if (inCatalog === false) return "var(--status-warning)";
  return "var(--success)";
}

export default function RatingRuleLinkPanel({
  planId,
  planStatus,
  ocsRules,
  ratingList,
  t,
  compact = false,
}: {
  planId: string;
  planStatus: string;
  ocsRules: RatingRule[];
  ratingList?: RatingRule[];
  t: Translator;
  compact?: boolean;
}) {
  const planRules = Array.isArray(ocsRules) && ocsRules.length > 0 ? ocsRules : [];
  const catalogRules = Array.isArray(ratingList) ? ratingList : [];
  const catalogGroups = new Set(catalogRules.map(ratingGroup).filter(Boolean));
  const hasCatalog = catalogRules.length > 0;
  const missingCatalogGroups = planRules
    .map(ratingGroup)
    .filter((group) => group > 0 && hasCatalog && !catalogGroups.has(group));
  const scenarioRows = scenarios.map((scenario) => {
    const planRule = planRules.find(scenario.match) || catalogRules.find(scenario.match);
    const group = planRule ? ratingGroup(planRule) : 0;
    const inCatalog = !planRule || !hasCatalog || group <= 0 ? null : catalogGroups.has(group);
    return { ...scenario, planRule, group, inCatalog };
  });
  const missingScenarioCount = scenarioRows.filter((row) => !row.planRule).length;
  const hasWarning = missingScenarioCount > 0 || missingCatalogGroups.length > 0;

  return (
    <div className={`rating-panel-container ${compact ? "rating-panel-compact" : ""} ${hasWarning ? "rating-panel-warning" : "rating-panel-normal"}`}>
      <div className="rating-panel-header">
        <div>
          <div className="rating-panel-title-box">
            {hasWarning ? <AlertTriangle size={17} color="var(--status-warning)" /> : <CheckCircle2 size={17} color="var(--status-success)" />}
            {t("rating_linkage_title")}
          </div>
          <div className="rating-panel-subtitle">
            {t("rating_linkage_plan")} <span className="rating-panel-mono">{planId || "plan_default_10gb"}</span>
            <span className="rating-panel-sep">/</span>
            {t("status")} <span className="rating-panel-mono">{planStatus || t("unknown")}</span>
          </div>
        </div>
        <a
          href="/rating"
          target="_blank"
          rel="noreferrer"
          className="btn btn-outline rating-panel-btn"
        >
          <ExternalLink size={14} />
          {t("rating_management")}
        </a>
      </div>

      <div className="rating-panel-grid">
        {scenarioRows.map((row) => {
          const found = !!row.planRule;
          const color = statusColor(found, row.inCatalog);
          return (
            <div key={row.key} className="rating-scenario-card">
              <div className="rating-scenario-header">
                <div className={`rating-scenario-title ${found ? "rating-scenario-title-found" : "rating-scenario-title-missing"}`}>
                  {row.icon}
                  {t(row.labelKey)}
                </div>
                <span
                  className="rating-scenario-badge"
                  style={{ color, border: `1px solid ${color}` }}
                >
                  {statusText(found, row.inCatalog, t)}
                </span>
              </div>
              <div className="rating-scenario-desc">{t(row.descriptionKey)}</div>
              {row.planRule ? (
                <div className="rating-scenario-details">
                  <span className="rating-scenario-detail-item">RG <strong className="rating-panel-mono">{row.group || "-"}</strong></span>
                  <span className="rating-scenario-detail-item">SI <strong className="rating-panel-mono">{row.planRule.service_identifier ?? "-"}</strong></span>
                  <span className="rating-scenario-detail-item">APN <strong className="rating-panel-mono">{row.planRule.apn || "-"}</strong></span>
                  <span className="rating-scenario-detail-item">{t("rating_grant")} <strong className="rating-panel-mono">{formatGrant(row.planRule, t)}</strong></span>
                </div>
              ) : (
                <div className="rating-scenario-missing-rule">
                  {t("rating_link_no_mapped_rule")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(missingCatalogGroups.length > 0 || missingScenarioCount > 0) && (
        <div className="rating-panel-footer">
          {missingCatalogGroups.length > 0
            ? `${t("rating_link_catalog_missing", { groups: Array.from(new Set(missingCatalogGroups)).join(", ") })} `
            : ""}
          {missingScenarioCount > 0
            ? t("rating_link_review_before_save")
            : t("rating_link_open_management")}
        </div>
      )}
    </div>
  );
}
