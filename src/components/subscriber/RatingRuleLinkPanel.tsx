import { AlertTriangle, CheckCircle2, Database, ExternalLink, Mic2, ShieldCheck } from "lucide-react";
import type React from "react";
import { formatBytes, formatSeconds } from "@/lib/unitParser";

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

type ScenarioKey = "data" | "ims" | "voice";

type Scenario = {
  key: ScenarioKey;
  label: string;
  description: string;
  icon: React.ReactNode;
  match: (rule: RatingRule) => boolean;
};

const scenarios: Scenario[] = [
  {
    key: "data",
    label: "Data Volume",
    description: "Internet/APN data quota",
    icon: <Database size={16} />,
    match: (rule) => rule.charging_type === "data_volume" && (rule.apn || "internet") !== "ims",
  },
  {
    key: "ims",
    label: "IMS Signaling",
    description: "IMS registration and signaling",
    icon: <ShieldCheck size={16} />,
    match: (rule) => (rule.apn || "").toLowerCase() === "ims" && rule.charging_type === "free",
  },
  {
    key: "voice",
    label: "IMS Voice",
    description: "Voice duration charging",
    icon: <Mic2 size={16} />,
    match: (rule) => rule.charging_type === "voice_time",
  },
];

function ratingGroup(rule: RatingRule) {
  return Number(rule.rating_group_id ?? rule.rating_group ?? 0);
}

function formatGrant(rule?: RatingRule) {
  if (!rule) return "-";
  const grant = Number(rule.quota_per_grant ?? 0);
  if (rule.charging_type === "free" || grant <= 0) return "Included";
  if (rule.charging_type === "voice_time" || rule.unit === "seconds") return formatSeconds(grant);
  return formatBytes(grant);
}

function statusText(found: boolean, inCatalog: boolean | null) {
  if (!found) return "Missing";
  if (inCatalog === false) return "Plan only";
  return "Linked";
}

function statusColor(found: boolean, inCatalog: boolean | null) {
  if (!found) return "var(--danger)";
  if (inCatalog === false) return "var(--warning, #f59e0b)";
  return "var(--success)";
}

export default function RatingRuleLinkPanel({
  planId,
  planStatus,
  ocsRules,
  ratingList,
  compact = false,
}: {
  planId: string;
  planStatus: string;
  ocsRules: RatingRule[];
  ratingList?: RatingRule[];
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
    <div
      style={{
        gridColumn: "1 / -1",
        border: `1px solid ${hasWarning ? "color-mix(in srgb, var(--warning, #f59e0b) 45%, var(--surface-border))" : "var(--surface-border)"}`,
        borderRadius: "8px",
        background: hasWarning ? "color-mix(in srgb, var(--warning, #f59e0b) 7%, var(--surface))" : "var(--surface)",
        padding: compact ? "0.85rem" : "1rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "0.9rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--text-main)", fontWeight: 800 }}>
            {hasWarning ? <AlertTriangle size={17} color="var(--warning, #f59e0b)" /> : <CheckCircle2 size={17} color="var(--success)" />}
            Tariff Linkage
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginTop: "0.25rem" }}>
            Subscriber plan <span style={{ fontFamily: "monospace", color: "var(--text-main)" }}>{planId || "plan_default_10gb"}</span>
            <span style={{ margin: "0 0.35rem" }}>·</span>
            Status <span style={{ fontFamily: "monospace", color: "var(--text-main)" }}>{planStatus || "unknown"}</span>
          </div>
        </div>
        <a
          href="/rating"
          target="_blank"
          rel="noreferrer"
          className="btn btn-outline"
          style={{ minHeight: 34, padding: "0.35rem 0.7rem", display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem" }}
        >
          <ExternalLink size={14} />
          Rating Management
        </a>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "0.7rem" }}>
        {scenarioRows.map((row) => {
          const found = !!row.planRule;
          const color = statusColor(found, row.inCatalog);
          return (
            <div key={row.key} style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "0.85rem", background: "var(--header-bg)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", color: found ? "var(--text-main)" : "var(--text-muted)", fontWeight: 800 }}>
                  {row.icon}
                  {row.label}
                </div>
                <span style={{ color, border: `1px solid ${color}`, borderRadius: "999px", padding: "0.18rem 0.48rem", fontSize: "0.72rem", fontWeight: 800 }}>
                  {statusText(found, row.inCatalog)}
                </span>
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: "0.35rem" }}>{row.description}</div>
              {row.planRule ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.45rem 0.8rem", marginTop: "0.75rem", fontSize: "0.8rem" }}>
                  <span style={{ color: "var(--text-muted)" }}>RG <strong style={{ color: "var(--text-main)", fontFamily: "monospace" }}>{row.group || "-"}</strong></span>
                  <span style={{ color: "var(--text-muted)" }}>SI <strong style={{ color: "var(--text-main)", fontFamily: "monospace" }}>{row.planRule.service_identifier ?? "-"}</strong></span>
                  <span style={{ color: "var(--text-muted)" }}>APN <strong style={{ color: "var(--text-main)", fontFamily: "monospace" }}>{row.planRule.apn || "-"}</strong></span>
                  <span style={{ color: "var(--text-muted)" }}>Grant <strong style={{ color: "var(--text-main)", fontFamily: "monospace" }}>{formatGrant(row.planRule)}</strong></span>
                </div>
              ) : (
                <div style={{ marginTop: "0.75rem", color: "var(--danger)", fontSize: "0.8rem", fontWeight: 700 }}>
                  No mapped rule found in this plan.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(missingCatalogGroups.length > 0 || missingScenarioCount > 0) && (
        <div style={{ marginTop: "0.85rem", color: "var(--text-secondary)", fontSize: "0.82rem", lineHeight: 1.5 }}>
          {missingCatalogGroups.length > 0
            ? `Plan rule RG ${Array.from(new Set(missingCatalogGroups)).join(", ")} is not present in the rating catalog. `
            : ""}
          {missingScenarioCount > 0
            ? "Review the linked rating rules before saving this subscriber."
            : "Open Rating Management to reconcile catalog and plan rules."}
        </div>
      )}
    </div>
  );
}
