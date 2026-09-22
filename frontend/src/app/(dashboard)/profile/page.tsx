"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { AlertTriangle, Boxes, Clock, Pencil, Plus, Users } from "lucide-react";
import ProfileModal from "@/components/ProfileModal";
import { EmptyState, LoadingRows, OperationNotice } from "@/components/OperationFeedback";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { useAuth } from "@/hooks/useAuth";

import PageHeader from "@/components/ui/PageHeader";
import MetricStrip from "@/components/ui/MetricStrip";
import "./profile.css";

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
  const { canEditTemplates } = useAuth();

  // eslint-disable-next-line -- Date.now() is intentionally read once per render for the 14-day window check
  const now = Date.now();

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
      return now - new Date(changedAt).getTime() <= 1000 * 60 * 60 * 24 * 14;
    }).length,
  }), [backendSummary, governedProfiles, now]);

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

        <div className="page-action-bar profile-action-bar">
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
          <div className="dash-card profile-table-state">
            <LoadingRows columns={9} rows={4} />
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="dash-card profile-table-state">
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
          <div className="dash-card profile-table-card">
            <div className="profile-table-wrap">
              <table className="profile-governance-table">
                <caption className="sr-only">{t("prof_governance_title")}</caption>
                <thead>
                  <tr>
                    <th data-column-priority="essential">{t("prof_table_template")}</th>
                    <th data-column-priority="essential">{t("prof_table_domain")}</th>
                    <th data-column-priority="essential">{t("prof_table_risk")}</th>
                    <th data-column-priority="important" className="profile-table-number">{t("prof_table_slices")}</th>
                    <th data-column-priority="important" className="profile-table-number">{t("prof_table_linked_users")}</th>
                    <th data-column-priority="essential">{t("prof_table_main_effect")}</th>
                    <th data-column-priority="supplementary">{t("prof_table_modified_by")}</th>
                    <th data-column-priority="essential">{t("prof_table_updated")}</th>
                    <th data-column-priority="essential" className="profile-table-actions-heading">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProfiles.map(profile => (
                    <tr key={profile.name}>
                      <td data-label={t("prof_table_template")} data-column-priority="essential">
                        <button
                          type="button"
                          className="profile-template-button"
                          onClick={() => handleOpenEdit(profile.name)}
                          aria-label={`${t("edit")}: ${profile.title || profile.name}`}
                        >
                          <span className="profile-template-title">{profile.title || profile.name}</span>
                          <span className="profile-template-key">{profile.name}</span>
                        </button>
                      </td>
                      <td data-label={t("prof_table_domain")} data-column-priority="essential">
                        <span className={`profile-domain-badge profile-domain-${profile.domain}`}>
                          {t(`prof_domain_${profile.domain}`)}
                        </span>
                      </td>
                      <td data-label={t("prof_table_risk")} data-column-priority="essential">
                        <span className={`profile-risk-badge profile-risk-${profile.risk}`}>
                          {t(`prof_risk_${profile.risk}`)}
                        </span>
                      </td>
                      <td data-label={t("prof_table_slices")} data-column-priority="important" className="profile-table-number profile-table-data">
                        {profile.sliceCount || 0}
                      </td>
                      <td data-label={t("prof_table_linked_users")} data-column-priority="important" className="profile-table-number profile-table-data">
                        {profile.impactedSubscribers}
                      </td>
                      <td data-label={t("prof_table_main_effect")} data-column-priority="essential" className="profile-impact-cell">
                        {t(`prof_preview_${profile.domain}`)}
                      </td>
                      <td data-label={t("prof_table_modified_by")} data-column-priority="supplementary" className="profile-owner-cell">
                        {profile.updatedBy || t("prof_governance_no_owner")}
                      </td>
                      <td data-label={t("prof_table_updated")} data-column-priority="essential" className="profile-date-cell">
                        {formatDate(profile.updatedAt || profile.createdAt)}
                      </td>
                      <td data-label={t("actions")} data-column-priority="essential" className="profile-table-actions">
                        <button
                          type="button"
                          className="profile-row-action"
                          onClick={() => handleOpenEdit(profile.name)}
                          title={t("edit")}
                          aria-label={`${t("edit")}: ${profile.title || profile.name}`}
                        >
                          <Pencil size={17} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

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
