"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AlertTriangle, ArrowRight, Boxes, Clock, Gauge, Layers, Plus, ShieldCheck, UserRound, Users } from "lucide-react";
import ProfileModal from "@/components/ProfileModal";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";

import PageHeader from "@/components/ui/PageHeader";
import MetricStrip from "@/components/ui/MetricStrip";

interface ProfileSummary {
  name: string;
  title?: string;
  sliceCount?: number;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  subscriberCount?: number;
  impactedSubscribers?: number;
  activeSubscribers?: number;
  suspendedSubscribers?: number;
  restrictedSubscribers?: number;
}

interface ProfileGlobalSummary {
  totalProfiles: number;
  totalGovernedSubscribers: number;
  activeSubscribers: number;
  suspendedSubscribers: number;
  restrictedSubscribers: number;
  unassignedProfiles: number;
}

interface ProfilesResponse {
  profiles: ProfileSummary[];
  summary?: ProfileGlobalSummary;
}

type GovernanceDomain = "all" | "billing" | "network" | "slice" | "access";
type ProfileDomain = Exclude<GovernanceDomain, "all">;
type RiskLevel = "low" | "medium" | "high";
type ProfileNotice = { type: "success" | "error"; text: string };

const DOMAIN_OPTIONS: GovernanceDomain[] = ["all", "billing", "network", "slice", "access"];

const RISK_STYLE: Record<RiskLevel, { color: string; background: string; border: string }> = {
  low: {
    color: "var(--success)",
    background: "var(--status-success-soft)",
    border: "var(--status-success-border)",
  },
  medium: {
    color: "var(--warning)",
    background: "var(--status-warning-soft)",
    border: "var(--status-warning-border)",
  },
  high: {
    color: "var(--danger)",
    background: "var(--status-danger-soft)",
    border: "var(--status-danger-border)",
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
  const profileRows = data?.profiles;
  const backendSummary = data?.summary;
  const profiles = useMemo(() => profileRows || [], [profileRows]);
  const [searchQuery, setSearchQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<GovernanceDomain>("all");
  const [modalProfileName, setModalProfileName] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [notice, setNotice] = useState<ProfileNotice | null>(null);
  const [currentTime] = useState(() => Date.now());
  const { canEditTemplates } = useAuth();

  const governedProfiles = useMemo(() => profiles.map(profile => {
    const impactedSubscribers = profile.subscriberCount ?? profile.impactedSubscribers ?? 0;
    const sliceCount = profile.sliceCount || 0;
    return {
      ...profile,
      domain: inferProfileDomain(profile),
      impactedSubscribers,
      risk: getRiskLevel(sliceCount, impactedSubscribers),
    };
  }), [profiles]);

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
    total: backendSummary?.totalProfiles ?? governedProfiles.length,
    impacted: backendSummary?.totalGovernedSubscribers ?? governedProfiles.reduce((sum, profile) => sum + profile.impactedSubscribers, 0),
    highRisk: governedProfiles.filter(profile => profile.risk === "high").length,
    recentlyChanged: governedProfiles.filter(profile => {
      const changedAt = profile.updatedAt || profile.createdAt;
      if (!changedAt) return false;
      return currentTime - new Date(changedAt).getTime() <= 1000 * 60 * 60 * 24 * 14;
    }).length,
  }), [backendSummary, currentTime, governedProfiles]);

  const handleOpenNew = () => {
    setNotice(null);
    setModalProfileName(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (name: string) => {
    setNotice(null);
    setModalProfileName(name);
    setIsModalOpen(true);
  };

  const formatDate = (value?: string) => {
    if (!value) return t("prof_governance_not_modified");
    return new Date(value).toLocaleDateString();
  };

  return (
    <>
      <div className="container animate-fade-in profile-page-container">
        <PageHeader
          eyebrow={t("eyebrow_policy_template")}
          icon={<Boxes size={23} />}
          title={t("prof_governance_title")}
          description={t("prof_governance_subtitle")}
        />

        {notice && (
          <OperationNotice
            presentation="modal"
            tone={notice.type === "error" ? "danger" : "success"}
            title={notice.type === "error" ? t("error") : t("success")}
            message={notice.text}
            onClose={() => setNotice(null)}
          />
        )}

        <MetricStrip
          ariaLabel={t("prof_governance_title")}
          items={[
            { key: "total", icon: <Boxes size={17} />, label: t("prof_governance_total"), value: governanceSummary.total },
            { key: "impacted", icon: <Users size={17} />, label: t("prof_governance_impacted"), value: governanceSummary.impacted },
            { key: "risk", icon: <AlertTriangle size={17} />, label: t("prof_governance_high_risk"), value: governanceSummary.highRisk, tone: "danger" },
            { key: "recent", icon: <Clock size={17} />, label: t("prof_governance_recent"), value: governanceSummary.recentlyChanged },
          ]}
        />

        <div className="page-action-bar">
          <input
            type="search"
            className="form-input hover-glass profile-search-input"
            placeholder={t("prof_search_ph")}
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
          />
          <div className="profile-domain-filters">
            {DOMAIN_OPTIONS.map(domain => (
              <button
                key={domain}
                type="button"
                className={`${domainFilter === domain ? "btn btn-primary" : "btn btn-outline"} profile-domain-btn`}
                onClick={() => setDomainFilter(domain)}
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
          <div className="dash-card profile-empty-card">
            <LoadingRows columns={4} rows={4} />
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="dash-card profile-empty-card">
            <EmptyState
              icon={<Boxes size={48} />}
              title={searchQuery || domainFilter !== "all" ? t("prof_no_match") : t("prof_empty_list")}
              description={searchQuery || domainFilter !== "all" ? t("prof_empty_filtered_desc") : t("prof_empty_desc")}
              action={
                canEditTemplates && !searchQuery && domainFilter === "all" ? (
                  <button type="button" className="btn btn-primary" onClick={handleOpenNew}>
                    <Plus size={16} /> {t("prof_new_profile")}
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="imsi-grid">
            {filteredProfiles.map(profile => (
              <div
                key={profile.name}
                className="dash-card profile-imsi-card"
                onClick={() => handleOpenEdit(profile.name)}
              >
                <div className="profile-card-header">
                  <div className="profile-card-title-box">
                    <div className="profile-card-title">
                      {profile.title || profile.name}
                    </div>
                    <div className="profile-card-subtitle">
                      {profile.name}
                    </div>
                  </div>
                  <span
                    className="profile-risk-badge"
                    style={{
                      border: `1px solid ${RISK_STYLE[profile.risk].border}`,
                      background: RISK_STYLE[profile.risk].background,
                      color: RISK_STYLE[profile.risk].color,
                    }}
                  >
                    {t(`prof_risk_${profile.risk}`)}
                  </span>
                </div>

                <div className="profile-tags-row">
                  <span className="profile-tag-bordered">
                    <Gauge size={14} /> {t(`prof_domain_${profile.domain}`)}
                  </span>
                  <span className="profile-tag">
                    <Layers size={16} /> {t("prof_slices_count", { count: profile.sliceCount || 0 })}
                  </span>
                  <span className="profile-tag">
                    <Users size={16} /> {t("prof_governance_subscribers", { count: profile.impactedSubscribers })}
                  </span>
                </div>

                <div className="profile-preview-box">
                  <div className="profile-preview-header">
                    <ShieldCheck size={15} color="var(--primary)" /> {t("prof_governance_change_preview")}
                  </div>
                  <div className="profile-preview-content">
                    <div className="profile-preview-row">
                      <span>{t("prof_governance_scope")}</span>
                      <strong className="profile-preview-value">{t("prof_governance_scope_value", { count: profile.impactedSubscribers })}</strong>
                    </div>
                    <div className="profile-preview-row">
                      <span>{t("prof_governance_next_change")}</span>
                      <strong className="profile-preview-value">{t(`prof_preview_${profile.domain}`)}</strong>
                    </div>
                  </div>
                </div>

                <div className="profile-meta-row">
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
          onOperation={setNotice}
          impactedSubscribers={modalProfileName ? (governedProfiles.find(p => p.name === modalProfileName)?.impactedSubscribers || 0) : 0}
        />
      )}
    </>
  );
}
