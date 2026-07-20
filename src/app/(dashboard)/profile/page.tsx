"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AlertTriangle, ArrowRight, Boxes, Clock, Gauge, Layers, Plus, ShieldCheck, UserRound, Users } from "lucide-react";
import ProfileModal from "@/components/ProfileModal";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";

interface ProfileSummary {
  name: string;
  title?: string;
  sliceCount?: number;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface ProfilesResponse {
  profiles: ProfileSummary[];
}

interface SubscriberRow {
  imsi: string;
  profile?: string;
}

interface SubscribersResponse {
  subscribers: SubscriberRow[];
  total: number;
}

type GovernanceDomain = "all" | "billing" | "network" | "slice" | "access";
type ProfileDomain = Exclude<GovernanceDomain, "all">;
type RiskLevel = "low" | "medium" | "high";

const DOMAIN_OPTIONS: GovernanceDomain[] = ["all", "billing", "network", "slice", "access"];

const RISK_STYLE: Record<RiskLevel, { color: string; background: string; border: string }> = {
  low: {
    color: "var(--success)",
    background: "rgba(16, 185, 129, 0.1)",
    border: "rgba(16, 185, 129, 0.24)",
  },
  medium: {
    color: "var(--warning)",
    background: "rgba(245, 158, 11, 0.1)",
    border: "rgba(245, 158, 11, 0.24)",
  },
  high: {
    color: "var(--danger)",
    background: "rgba(239, 68, 68, 0.1)",
    border: "rgba(239, 68, 68, 0.24)",
  },
};

function inferProfileDomain(profile: ProfileSummary): ProfileDomain {
  const searchable = `${profile.name} ${profile.title || ""}`.toLowerCase();
  const sliceCount = profile.sliceCount || 0;
  if (searchable.includes("slice") || searchable.includes("nssai") || sliceCount >= 3) return "slice";
  if (searchable.includes("access") || searchable.includes("bar") || searchable.includes("restrict")) return "access";
  if (searchable.includes("ambr") || searchable.includes("network") || searchable.includes("qos")) return "network";
  return "billing";
}

function getRiskLevel(sliceCount: number, impactedSubscribers: number): RiskLevel {
  if (impactedSubscribers >= 20 || sliceCount >= 4) return "high";
  if (impactedSubscribers >= 5 || sliceCount >= 2) return "medium";
  return "low";
}

export default function ProfilePage() {
  const { t } = useI18n();
  const { data, isLoading, mutate } = useSWR<ProfilesResponse>("/api/profiles", fetcher);
  const { data: subscriberData } = useSWR<SubscribersResponse>("/api/subscribers?detail=true&page=1&limit=500", fetcher);
  const profileRows = data?.profiles;
  const subscriberRows = subscriberData?.subscribers;
  const profiles = useMemo(() => profileRows || [], [profileRows]);
  const subscribers = useMemo(() => subscriberRows || [], [subscriberRows]);
  const [searchQuery, setSearchQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<GovernanceDomain>("all");
  const [modalProfileName, setModalProfileName] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentTime] = useState(() => Date.now());
  const { canEditTemplates } = useAuth();

  const profileImpactCounts = useMemo(() => {
    const counts = new Map<string, number>();
    subscribers.forEach(subscriber => {
      const profileName = String(subscriber.profile || "");
      if (!profileName) return;
      counts.set(profileName, (counts.get(profileName) || 0) + 1);
    });
    return counts;
  }, [subscribers]);

  const governedProfiles = useMemo(() => profiles.map(profile => {
    const impactedSubscribers = profileImpactCounts.get(profile.name) || 0;
    const sliceCount = profile.sliceCount || 0;
    return {
      ...profile,
      domain: inferProfileDomain(profile),
      impactedSubscribers,
      risk: getRiskLevel(sliceCount, impactedSubscribers),
    };
  }), [profileImpactCounts, profiles]);

  const filteredProfiles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return governedProfiles.filter(profile => {
      const matchesSearch = !normalizedQuery ||
        profile.name.toLowerCase().includes(normalizedQuery) ||
        String(profile.title || "").toLowerCase().includes(normalizedQuery);
      const matchesDomain = domainFilter === "all" || profile.domain === domainFilter;
      return matchesSearch && matchesDomain;
    });
  }, [domainFilter, governedProfiles, searchQuery]);

  const governanceSummary = useMemo(() => ({
    total: governedProfiles.length,
    impacted: governedProfiles.reduce((sum, profile) => sum + profile.impactedSubscribers, 0),
    highRisk: governedProfiles.filter(profile => profile.risk === "high").length,
    recentlyChanged: governedProfiles.filter(profile => {
      const changedAt = profile.updatedAt || profile.createdAt;
      if (!changedAt) return false;
      return currentTime - new Date(changedAt).getTime() <= 1000 * 60 * 60 * 24 * 14;
    }).length,
  }), [currentTime, governedProfiles]);

  const handleOpenNew = () => {
    setModalProfileName(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (name: string) => {
    setModalProfileName(name);
    setIsModalOpen(true);
  };

  const formatDate = (value?: string) => {
    if (!value) return t("prof_governance_not_modified");
    return new Date(value).toLocaleDateString();
  };

  return (
    <>
      <div className="container animate-fade-in" style={{ padding: "3rem", paddingBottom: "100px" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <h1 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700, color: "var(--text-main)" }}>{t("prof_governance_title")}</h1>
          <p style={{ margin: "0.5rem 0 0", color: "var(--text-muted)", fontSize: "0.95rem" }}>{t("prof_governance_subtitle")}</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
          {[
            { icon: <Boxes size={18} color="var(--primary)" />, label: t("prof_governance_total"), value: governanceSummary.total },
            { icon: <Users size={18} color="var(--primary)" />, label: t("prof_governance_impacted"), value: governanceSummary.impacted },
            { icon: <AlertTriangle size={18} color="var(--danger)" />, label: t("prof_governance_high_risk"), value: governanceSummary.highRisk },
            { icon: <Clock size={18} color="var(--primary)" />, label: t("prof_governance_recent"), value: governanceSummary.recentlyChanged },
          ].map(metric => (
            <div key={metric.label} className="dash-card" style={{ padding: "1rem", display: "flex", gap: "0.75rem", alignItems: "center", minHeight: "86px" }}>
              <div style={{ width: 38, height: 38, borderRadius: "8px", display: "grid", placeItems: "center", background: "var(--surface-hover)", flex: "0 0 auto" }}>
                {metric.icon}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--text-muted)", fontSize: "0.78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0 }}>{metric.label}</div>
                <div style={{ color: "var(--text-main)", fontSize: "1.35rem", fontWeight: 800, marginTop: "0.15rem" }}>{metric.value}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="page-action-bar">
          <input
            type="search"
            className="form-input hover-glass"
            style={{ width: "min(520px, 100%)", borderRadius: "20px", padding: "0.7rem 1.2rem" }}
            placeholder={t("prof_search_ph")}
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
          />
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
            {DOMAIN_OPTIONS.map(domain => (
              <button
                key={domain}
                type="button"
                className={domainFilter === domain ? "btn btn-primary" : "btn btn-outline"}
                onClick={() => setDomainFilter(domain)}
                style={{ padding: "0.55rem 0.85rem", fontSize: "0.82rem" }}
              >
                {t(`prof_domain_${domain}`)}
              </button>
            ))}
          </div>
          {canEditTemplates && (
            <div className="page-action-buttons">
              <button className="btn btn-primary" onClick={handleOpenNew} title={t("prof_btn_create")}>
                <Plus size={16} /> {t("prof_new_profile")}
              </button>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="text-center mt-8 text-muted">{t("prof_loading_list")}</div>
        ) : filteredProfiles.length === 0 ? (
          <div className="text-center mt-8 text-muted bg-white p-12 shadow" style={{ borderRadius: "4px" }}>
            {searchQuery ? t("prof_no_match") : t("prof_empty_list")}
          </div>
        ) : (
          <div className="imsi-grid">
            {filteredProfiles.map(profile => (
              <div
                key={profile.name}
                className="imsi-card"
                onClick={() => handleOpenEdit(profile.name)}
                style={{ cursor: "pointer", display: "flex", flexDirection: "column", gap: "0.9rem", padding: "1.5rem" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--text-main)", overflowWrap: "anywhere" }}>
                      {profile.title || profile.name}
                    </div>
                    <div style={{ marginTop: "0.3rem", color: "var(--text-muted)", fontSize: "0.78rem", fontFamily: "monospace", overflowWrap: "anywhere" }}>
                      {profile.name}
                    </div>
                  </div>
                  <span
                    style={{
                      border: `1px solid ${RISK_STYLE[profile.risk].border}`,
                      background: RISK_STYLE[profile.risk].background,
                      color: RISK_STYLE[profile.risk].color,
                      borderRadius: "999px",
                      padding: "0.28rem 0.6rem",
                      fontSize: "0.75rem",
                      fontWeight: 800,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t(`prof_risk_${profile.risk}`)}
                  </span>
                </div>

                <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap", fontSize: "0.82rem", color: "var(--text-secondary)" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.35rem 0.55rem", border: "1px solid var(--surface-border)", borderRadius: "999px", color: "var(--text-secondary)", fontSize: "0.78rem", fontWeight: 700 }}>
                    <Gauge size={14} /> {t(`prof_domain_${profile.domain}`)}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.35rem 0.55rem" }}>
                    <Layers size={16} /> {t("prof_slices_count", { count: profile.sliceCount || 0 })}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", padding: "0.35rem 0.55rem" }}>
                    <Users size={16} /> {t("prof_governance_subscribers", { count: profile.impactedSubscribers })}
                  </span>
                </div>

                <div style={{ border: "1px solid var(--surface-border)", borderRadius: "8px", padding: "0.85rem", background: "var(--header-bg)", display: "grid", gap: "0.55rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", color: "var(--text-main)", fontWeight: 800, fontSize: "0.85rem" }}>
                    <ShieldCheck size={15} color="var(--primary)" /> {t("prof_governance_change_preview")}
                  </div>
                  <div style={{ display: "grid", gap: "0.45rem", color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.8rem" }}>
                      <span>{t("prof_governance_scope")}</span>
                      <strong style={{ color: "var(--text-main)" }}>{t("prof_governance_scope_value", { count: profile.impactedSubscribers })}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.8rem" }}>
                      <span>{t("prof_governance_next_change")}</span>
                      <strong style={{ color: "var(--text-main)" }}>{t(`prof_preview_${profile.domain}`)}</strong>
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                  <UserRound size={14} /> {profile.updatedBy ? `${t("prof_modified_by")} ${profile.updatedBy}` : t("prof_governance_no_owner")}
                  <ArrowRight size={13} />
                  <Clock size={14} /> {formatDate(profile.updatedAt || profile.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {canEditTemplates && (
        <button
          className="fab"
          onClick={handleOpenNew}
          title={t("prof_btn_create")}
          aria-label={t("prof_btn_create")}
        >
          <Plus size={28} />
        </button>
      )}

      {isModalOpen && (
        <ProfileModal
          profileName={modalProfileName}
          onClose={() => setIsModalOpen(false)}
          onRefresh={() => mutate()}
        />
      )}
    </>
  );
}
