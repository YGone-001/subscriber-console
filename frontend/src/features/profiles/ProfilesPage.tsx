/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/profile/page.tsx
 * Adaptations: `@/` aliases and CSS imports repointed; `useSWR(fetcher)` replaced by the current read client; `useAuth().canEditTemplates` replaced by the shared capability helper.
 *
 * The table describes what each template actually contains. Business domain and
 * risk are not inferred from the template name, and an unavailable subscriber
 * aggregation is reported as unavailable instead of zero.
 */
import { useMemo, useState } from "react";
import { useI18n } from '../../providers/I18nProvider';
import { Boxes, Gauge, Link2Off, Pencil, Plus, Users } from "lucide-react";
import ProfileModal from '../../components/ProfileModal';
import { EmptyState, LoadingRows, OperationNotice } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { useRead } from '../../lib/api/use-read';
import { formatAmbrPair } from './profile-format';
import {
  countProfilesWithoutBilling,
  filterProfileList,
  linkedSubscriberCount,
  type ProfileListFilter,
} from './profile-list-model';

import PageHeader from '../../components/ui/PageHeader';
import MetricStrip from '../../components/ui/MetricStrip';

interface ProfileAmbrSide {
  unit?: number;
  value?: number;
}

interface ProfileSummary {
  name: string;
  title?: string;
  sliceCount?: number;
  sessionCount?: number;
  pccRuleCount?: number;
  ocsDefaultsConfigured?: boolean;
  accessRestriction?: number | null;
  ambr?: { downlink?: ProfileAmbrSide | null; uplink?: ProfileAmbrSide | null } | null;
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
  subscriberStatsCompleteness?: 'complete' | 'unavailable';
}

interface ProfilesResponse {
  profiles: ProfileSummary[];
  summary?: ProfileGlobalSummary;
}

type ProfileNotice = { type: 'success' | 'error'; text: string };

const FILTER_OPTIONS: ProfileListFilter[] = ['all', 'withBilling', 'withoutBilling', 'unassigned'];
const FILTER_LABEL_KEYS: Record<ProfileListFilter, string> = {
  all: 'prof_filter_all',
  withBilling: 'prof_filter_with_billing',
  withoutBilling: 'prof_filter_without_billing',
  unassigned: 'prof_filter_unassigned',
};

export function ProfilesPage() {
  const { t, formatDateTime } = useI18n();
  const { data, isLoading, error, mutate } = useRead<ProfilesResponse>('/api/profiles');
  const [searchQuery, setSearchQuery] = useState('');
  const [listFilter, setListFilter] = useState<ProfileListFilter>('all');
  const [modalProfileName, setModalProfileName] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [notice, setNotice] = useState<ProfileNotice | null>(null);
  const { user } = useAuth();
  const canEditTemplates = hasPermission(user, 'profiles.write');

  const profiles = useMemo(() => data?.profiles ?? [], [data?.profiles]);
  const backendSummary = data?.summary;
  const statsUnavailable = backendSummary?.subscriberStatsCompleteness === 'unavailable';

  const filteredProfiles = useMemo(
    () => filterProfileList(profiles, searchQuery, listFilter),
    [listFilter, profiles, searchQuery],
  );

  const metrics = useMemo(() => {
    const total = backendSummary?.totalProfiles ?? profiles.length;
    const impacted = backendSummary?.totalGovernedSubscribers
      ?? profiles.reduce((sum, profile) => sum + linkedSubscriberCount(profile), 0);
    const unassigned = backendSummary?.unassignedProfiles
      ?? profiles.filter((profile) => linkedSubscriberCount(profile) === 0).length;
    return {
      total,
      impacted,
      unassigned,
      withoutBilling: countProfilesWithoutBilling(profiles),
    };
  }, [backendSummary, profiles]);

  const impactBreakdown = backendSummary
    ? t('prof_stat_breakdown', {
      active: backendSummary.activeSubscribers,
      suspended: backendSummary.suspendedSubscribers,
      restricted: backendSummary.restrictedSubscribers,
    })
    : undefined;

  const handleOpenNew = () => {
    setNotice(null);
    setModalProfileName(null);
    setIsModalOpen(true);
  };

  const handleOpenTemplate = (name: string) => {
    setNotice(null);
    setModalProfileName(name);
    setIsModalOpen(true);
  };

  const hasActiveFilter = searchQuery.trim() !== '' || listFilter !== 'all';

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
            { key: "total", icon: <Boxes size={17} />, label: t("prof_governance_total"), value: metrics.total },
            {
              key: "impacted",
              icon: <Users size={17} />,
              label: t("prof_governance_impacted"),
              value: statsUnavailable ? t("prof_stats_unavailable") : metrics.impacted,
              tone: statsUnavailable ? "muted" : "primary",
              detail: statsUnavailable ? undefined : impactBreakdown,
            },
            {
              key: "unassigned",
              icon: <Link2Off size={17} />,
              label: t("prof_metric_unassigned"),
              value: statsUnavailable ? t("prof_stats_unavailable") : metrics.unassigned,
              tone: "muted",
            },
            {
              key: "withoutBilling",
              icon: <Gauge size={17} />,
              label: t("prof_metric_without_billing"),
              value: metrics.withoutBilling,
              tone: metrics.withoutBilling > 0 ? "warning" : "success",
            },
          ]}
        />

        <div className="page-action-bar profile-action-bar">
          <input
            type="search"
            className="form-input hover-glass profile-search-input"
            aria-label={t("prof_search_ph")}
            placeholder={t("prof_search_ph")}
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
          />
          <div className="profile-domain-filters" role="group" aria-label={t("prof_filter_group")}>
            {FILTER_OPTIONS.map(filter => (
              <button
                key={filter}
                type="button"
                className={`${listFilter === filter ? "btn btn-primary" : "btn btn-outline"} profile-domain-btn`}
                aria-pressed={listFilter === filter}
                onClick={() => setListFilter(filter)}
              >
                {t(FILTER_LABEL_KEYS[filter])}
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
            <LoadingRows columns={7} rows={4} />
          </div>
        ) : error ? (
          <div className="dash-card profile-table-state">
            <ErrorState
              title={t("prof_err_load")}
              message={error instanceof Error ? error.message : String(error)}
              retryLabel={t("retry")}
              onRetry={() => { void mutate(); }}
            />
          </div>
        ) : filteredProfiles.length === 0 ? (
          <div className="dash-card profile-table-state">
            <EmptyState
              icon={<Boxes size={48} />}
              title={hasActiveFilter ? t("prof_no_match") : t("prof_empty_list")}
              description={hasActiveFilter ? t("prof_empty_filtered_desc") : t("prof_empty_desc")}
              action={
                canEditTemplates && !hasActiveFilter ? (
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
                    <th data-column-priority="essential">{t("prof_table_content")}</th>
                    <th data-column-priority="important" className="profile-table-number">{t("prof_table_linked_users")}</th>
                    <th data-column-priority="supplementary">{t("prof_table_ambr")}</th>
                    <th data-column-priority="supplementary">{t("prof_table_modified_by")}</th>
                    <th data-column-priority="essential">{t("prof_table_updated")}</th>
                    <th data-column-priority="essential" className="profile-table-actions-heading">{t("actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProfiles.map((profile) => {
                    const linked = linkedSubscriberCount(profile);
                    const billingConfigured = profile.ocsDefaultsConfigured === true;
                    const accessConfigured = profile.accessRestriction !== null && profile.accessRestriction !== undefined;
                    return (
                      <tr key={profile.name}>
                        <td data-label={t("prof_table_template")} data-column-priority="essential">
                          <button
                            type="button"
                            className="profile-template-button"
                            onClick={() => handleOpenTemplate(profile.name)}
                            aria-label={`${t("prof_view_details")}: ${profile.title || profile.name}`}
                          >
                            <span className="profile-template-title">{profile.title || profile.name}</span>
                            <span className="profile-template-key">{profile.name}</span>
                          </button>
                        </td>
                        <td data-label={t("prof_table_content")} data-column-priority="essential" className="profile-content-cell">
                          <span className="profile-content-counts">
                            {t("prof_content_slices", { count: profile.sliceCount || 0 })}
                            {' · '}
                            {t("prof_content_sessions", { count: profile.sessionCount || 0 })}
                            {' · '}
                            {t("prof_content_pcc", { count: profile.pccRuleCount || 0 })}
                          </span>
                          <span className="profile-content-tags">
                            <span className={`profile-chip ${billingConfigured ? "profile-chip-ok" : "profile-chip-missing"}`}>
                              {billingConfigured ? t("prof_billing_configured") : t("prof_billing_missing")}
                            </span>
                            <span className={`profile-chip ${accessConfigured ? "profile-chip-ok" : "profile-chip-missing"}`}>
                              {accessConfigured ? t("prof_access_configured") : t("prof_access_missing")}
                            </span>
                          </span>
                        </td>
                        <td data-label={t("prof_table_linked_users")} data-column-priority="important" className="profile-linked-cell">
                          {statsUnavailable ? (
                            <span className="text-muted-label">{t("prof_stats_unavailable")}</span>
                          ) : linked > 0 ? (
                            <>
                              <span className="profile-table-data">{linked}</span>
                              <span className="profile-impact-breakdown">
                                {t("prof_stat_breakdown", {
                                  active: profile.activeSubscribers || 0,
                                  suspended: profile.suspendedSubscribers || 0,
                                  restricted: profile.restrictedSubscribers || 0,
                                })}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-label">{t("prof_unassigned")}</span>
                          )}
                        </td>
                        <td data-label={t("prof_table_ambr")} data-column-priority="supplementary">
                          {profile.ambr ? (
                            <span className="profile-ambr-cell">
                              {formatAmbrPair(profile.ambr, t("prof_diff_not_configured"), {
                                downlink: t("sub_dl"),
                                uplink: t("sub_ul"),
                              })}
                            </span>
                          ) : (
                            <span className="text-muted-label">{t("prof_diff_not_configured")}</span>
                          )}
                        </td>
                        <td data-label={t("prof_table_modified_by")} data-column-priority="supplementary" className="profile-owner-cell">
                          {profile.updatedBy || t("prof_governance_no_owner")}
                        </td>
                        <td data-label={t("prof_table_updated")} data-column-priority="essential" className="profile-date-cell">
                          {profile.updatedAt || profile.createdAt
                            ? formatDateTime(profile.updatedAt || profile.createdAt || '')
                            : t("prof_governance_not_modified")}
                        </td>
                        <td data-label={t("actions")} data-column-priority="essential" className="profile-table-actions">
                          <button
                            type="button"
                            className="profile-row-action"
                            onClick={() => handleOpenTemplate(profile.name)}
                            title={canEditTemplates ? t("edit") : t("prof_view_details")}
                            aria-label={`${canEditTemplates ? t("edit") : t("prof_view_details")}: ${profile.title || profile.name}`}
                          >
                            <Pencil size={17} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
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
          impactedSubscribers={modalProfileName ? linkedSubscriberCount(profiles.find((p) => p.name === modalProfileName) ?? { name: modalProfileName }) : 0}
        />
      )}
    </>
  );
}
