/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/profile/page.tsx
 * Adaptations: `@/` aliases and CSS imports repointed; `useSWR(fetcher)` replaced by the current read client; `useAuth().canEditTemplates` replaced by the shared capability helper.
 *
 * The table describes what each template actually contains. Business domain and
 * risk are not inferred from the template name, an unavailable subscriber
 * aggregation is reported as unavailable, and the filter/search state lives in
 * the URL so a filtered view survives reload and back/forward.
 */
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../providers/I18nProvider';
import { ArrowDown, ArrowUp, ArrowUpDown, Boxes, Download, Eye, Gauge, Link2Off, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { EmptyState, LoadingRows, ConfirmActionPanel, OperationNotice } from '../../components/ui/OperationFeedback';
import { ErrorState } from '../../components/ui/StatePanel';
import { SortableTableHeader } from '../../components/ui/SortableTableHeader';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import { useRead } from '../../lib/api/use-read';
import { getBlob, getJson } from '../../lib/api/read-client';
import { deleteJson } from '../../lib/api/mutation-client';
import { useAppRouter } from '../../lib/ui-compat/router';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { formatAmbrPairCompact } from './profile-format';
import {
  countProfilesWithoutBilling,
  DEFAULT_PROFILE_SORT_FIELD,
  defaultProfileSortDirection,
  linkedSubscriberCount,
  nextProfileSort,
  PROFILE_LIST_PAGE_SIZE,
  profileDirectionFromParam,
  profileFilterFromParam,
  profileFilterToParam,
  profilesListReadUrl,
  profileSortFromParam,
  type ProfileListFilter,
  type ProfileSortField,
} from './profile-list-model';
import type { ProfileListItem, ProfilesResponse } from './profile-types';

import PageHeader from '../../components/ui/PageHeader';
import MetricStrip from '../../components/ui/MetricStrip';
import styles from '../../styles/modules/profile.module.css';

const FILTER_OPTIONS: ProfileListFilter[] = ['all', 'withBilling', 'withoutBilling', 'unassigned'];
const FILTER_LABEL_KEYS: Record<ProfileListFilter, string> = {
  all: 'prof_filter_all',
  withBilling: 'prof_filter_with_billing',
  withoutBilling: 'prof_filter_without_billing',
  unassigned: 'prof_filter_unassigned',
};
const PROFILE_URL_KEYS = ['q', 'billing', 'sort', 'order', 'archived'] as const;

/* The ranking lives in the URL, so the read key, the header arrows and a shared
 * link describe the same order. Both parameters are written together: a
 * half-updated query would point its arrow at a ranking the server never answered
 * with. Returning to name ascending clears both, keeping the plain link tidy and
 * the default read cached under one key. */
function useProfilesListOrder() {
  const url = useOperationsUrlState({ keys: PROFILE_URL_KEYS });
  const sortField = profileSortFromParam(url.filters.sort);
  const sortDirection = profileDirectionFromParam(url.filters.order)
    ?? defaultProfileSortDirection(sortField);

  const applySort = (target: ProfileSortField) => {
    const next = nextProfileSort({ field: sortField, direction: sortDirection }, target);
    const isDefault = next.field === DEFAULT_PROFILE_SORT_FIELD
      && next.direction === defaultProfileSortDirection(next.field);
    url.setFilters(isDefault ? { sort: '', order: '' } : { sort: next.field, order: next.direction });
  };

  return { url, sortField, sortDirection, applySort };
}

export function ProfilesPage() {
  const { t, formatDateTime } = useI18n();
  const router = useAppRouter();
  const { url, sortField, sortDirection, applySort } = useProfilesListOrder();
  const { user } = useAuth();
  const canEditTemplates = hasPermission(user, 'profiles.write');

  const searchQuery = url.filters.q ?? '';
  const listFilter = profileFilterFromParam(url.filters.billing);
  const includeArchived = url.filters.archived === '1';
  const [searchInput, setSearchInput] = useState(searchQuery);

  /* The server owns the ranking and the facets, so the read key carries them; the
   * page only appends what it is handed, because filtering locally over a page
   * would hide matches the page never received. */
  const listUrl = useMemo(() => profilesListReadUrl({
    field: sortField,
    direction: sortDirection,
    query: searchQuery,
    billing: url.filters.billing ?? '',
    limit: PROFILE_LIST_PAGE_SIZE,
    includeArchived,
  }), [sortField, sortDirection, searchQuery, url.filters.billing, includeArchived]);
  const { data, isLoading, error, mutate } = useRead<ProfilesResponse>(listUrl);

  const [extraPages, setExtraPages] = useState<{ rows: ProfileListItem[]; nextCursor: string | null }[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    /* A new ranking or filter restarts the sequence; the cursor belonged to the
     * previous one. */
    setExtraPages([]);
  }, [listUrl]);

  const profiles = useMemo(
    () => [...(data?.profiles ?? []), ...extraPages.flatMap((page) => page.rows)],
    [data?.profiles, extraPages],
  );
  const backendSummary = data?.summary;
  const statsUnavailable = backendSummary?.subscriberStatsCompleteness === 'unavailable';

  const lastExtraPage = extraPages[extraPages.length - 1];
  const nextCursor = lastExtraPage ? lastExtraPage.nextCursor : (data?.nextCursor ?? null);
  const hasMore = lastExtraPage ? Boolean(lastExtraPage.nextCursor) : Boolean(data?.hasMore);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getJson<ProfilesResponse>(profilesListReadUrl({
        field: sortField,
        direction: sortDirection,
        query: searchQuery,
        billing: url.filters.billing ?? '',
        limit: PROFILE_LIST_PAGE_SIZE,
        cursor: nextCursor,
        includeArchived,
      }));
      setExtraPages((current) => [...current, {
        rows: page.profiles ?? [],
        nextCursor: page.nextCursor ?? null,
      }]);
    } finally {
      setLoadingMore(false);
    }
  };

  const renderSortIcon = (field: ProfileSortField) => {
    if (field !== sortField) return <ArrowUpDown size={14} className="sort-icon muted" />;
    return sortDirection === 'asc'
      ? <ArrowUp size={14} className="sort-icon active" />
      : <ArrowDown size={14} className="sort-icon active" />;
  };

  const metrics = useMemo(() => {
    const total = backendSummary?.totalProfiles ?? profiles.length;
    const impacted = backendSummary?.totalGovernedSubscribers
      ?? profiles.reduce((sum, profile) => sum + linkedSubscriberCount(profile), 0);
    const unassigned = backendSummary?.unassignedProfiles
      ?? profiles.filter((profile) => linkedSubscriberCount(profile) === 0).length;
    /* The server counts the whole collection. Counting the loaded rows here would
     * make this card describe the first page while its neighbours describe the
     * platform. */
    const withoutBilling = backendSummary?.profilesWithoutBilling
      ?? countProfilesWithoutBilling(profiles);
    return {
      total,
      impacted,
      unassigned,
      withoutBilling,
    };
  }, [backendSummary, profiles]);

  const impactBreakdown = backendSummary
    ? t('prof_stat_breakdown', {
      active: backendSummary.activeSubscribers,
      suspended: backendSummary.suspendedSubscribers,
      restricted: backendSummary.restrictedSubscribers,
    })
    : undefined;

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    url.setFilter('q', searchInput.trim());
  };

  const handleFilterChange = (filter: ProfileListFilter) => {
    url.setFilter('billing', profileFilterToParam(filter));
  };

  const openTemplate = (name: string) => {
    router.push(`/profile/${encodeURIComponent(name)}`);
  };

  const hasActiveFilter = searchQuery.trim() !== '' || listFilter !== 'all' || includeArchived;

  /* ------------------------------------------------------------ bulk actions -- */

  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{
    kind: 'export' | 'delete';
    total: number;
    done: number;
    failures: Array<{ name: string; reason: string }>;
  } | null>(null);
  const [bulkNotice, setBulkNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

  const toggleSelected = (name: string) => {
    setSelectedNames((current) => (current.includes(name)
      ? current.filter((entry) => entry !== name)
      : [...current, name]));
  };

  const clearSelection = () => setSelectedNames([]);

  const runBulkExport = async () => {
    const total = selectedNames.length;
    const failures: Array<{ name: string; reason: string }> = [];
    setBulk({ kind: 'export', total, done: 0, failures });
    for (const [index, name] of selectedNames.entries()) {
      try {
        const blob = await getBlob(`/api/profiles/${encodeURIComponent(name)}/export`);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `profile-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
      setBulk({ kind: 'export', total, done: index + 1, failures: [...failures] });
    }
    setBulk(null);
    clearSelection();
    setBulkNotice(failures.length === 0
      ? { tone: 'success', text: t('prof_bulk_export_done', { count: total }) }
      : {
        tone: 'danger',
        text: `${t('prof_bulk_export_failed', { count: failures.length, total })} ${t('prof_bulk_failures', { items: failures.slice(0, 3).map((failure) => failure.name).join(', ') })}`,
      });
  };

  const runBulkDelete = async () => {
    const total = selectedNames.length;
    const failures: Array<{ name: string; reason: string }> = [];
    setBulk({ kind: 'delete', total, done: 0, failures });
    for (const [index, name] of selectedNames.entries()) {
      try {
        await deleteJson(`/api/profiles/${encodeURIComponent(name)}`);
      } catch (error) {
        failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
      setBulk({ kind: 'delete', total, done: index + 1, failures: [...failures] });
    }
    setBulk(null);
    clearSelection();
    await mutate();
    setBulkNotice(failures.length === 0
      ? { tone: 'success', text: t('prof_bulk_delete_done', { count: total }) }
      : {
        tone: 'danger',
        text: `${t('prof_bulk_delete_failed', { count: failures.length, total })} ${t('prof_bulk_failures', { items: failures.slice(0, 3).map((failure) => failure.name).join(', ') })}`,
      });
  };

  const renderProfileRow = (profile: ProfileListItem) => {
    const linked = linkedSubscriberCount(profile);
    const archived = profile.archived === true;
    const billingConfigured = profile.ocsDefaultsConfigured === true;
    /* Three distinct states, one neutral tone: a configured restriction is a
     * business choice, not a defect, so only the billing gap keeps a signal
     * colour. Absent and 0 are not the same thing. */
    const access = profile.accessRestriction;
    const accessLabel = access === null || access === undefined
      ? t("prof_access_missing")
      : access === 0
        ? t("prof_access_unrestricted")
        : t("prof_access_limited");
    return (
      <tr key={profile.name}>
        <td className={styles.profileTableSelect} data-column-priority="essential">
          <input
            type="checkbox"
            className="checkbox-custom"
            aria-label={t('prof_select_row', { name: profile.title || profile.name })}
            checked={selectedNames.includes(profile.name)}
            onChange={() => toggleSelected(profile.name)}
          />
        </td>
        <td data-label={t("prof_table_template")} data-column-priority="essential">
          <button
            type="button"
            className={styles.profileTemplateButton}
            onClick={() => openTemplate(profile.name)}
            aria-label={`${t("prof_view_details")}: ${profile.title || profile.name}`}
          >
            <span className={styles.profileTemplateTitle}>{profile.title || profile.name}</span>
            <span className={styles.profileTemplateKey}>{profile.name}</span>
            {archived && <span className={`${styles.profileChip} ${styles.profileChipNeutral}`}>{t('prof_archived_badge')}</span>}
          </button>
        </td>
        <td data-label={t("prof_table_content")} data-column-priority="essential" className={styles.profileContentCell}>
          <span className={styles.profileContentCounts}>
            {t("prof_content_slices", { count: profile.sliceCount || 0 })}
            {' · '}
            {t("prof_content_sessions", { count: profile.sessionCount || 0 })}
            {' · '}
            {t("prof_content_pcc", { count: profile.pccRuleCount || 0 })}
          </span>
          <span className={styles.profileContentTags}>
            <span className={`${styles.profileChip} ${billingConfigured ? styles.profileChipOk : styles.profileChipMissing}`}>
              {billingConfigured ? t("prof_billing_configured") : t("prof_billing_missing")}
            </span>
            <span className={`${styles.profileChip} ${styles.profileChipNeutral}`}>
              {accessLabel}
            </span>
          </span>
        </td>
        <td data-label={t("prof_table_linked_users")} data-column-priority="important" className={styles.profileLinkedCell}>
          {statsUnavailable ? (
            <span className={styles.textMutedLabel}>{t("prof_stats_unavailable")}</span>
          ) : linked > 0 ? (
            <>
              <span className={styles.profileTableData}>{linked}</span>
              <span className={styles.profileImpactBreakdown}>
                {t("prof_stat_breakdown", {
                  active: profile.activeSubscribers || 0,
                  suspended: profile.suspendedSubscribers || 0,
                  restricted: profile.restrictedSubscribers || 0,
                })}
              </span>
            </>
          ) : (
            <span className={styles.textMutedLabel}>{t("prof_unassigned")}</span>
          )}
        </td>
        <td data-label={t("prof_table_ambr")} data-column-priority="supplementary">
          {profile.ambr ? (
            <span className={styles.profileAmbrCell}>
              {formatAmbrPairCompact(profile.ambr, t("prof_diff_not_configured"))}
            </span>
          ) : (
            <span className={styles.textMutedLabel}>{t("prof_diff_not_configured")}</span>
          )}
        </td>
        <td data-label={t("prof_table_modified_by")} data-column-priority="supplementary" className={styles.profileOwnerCell}>
          {profile.updatedBy || t("prof_governance_no_owner")}
        </td>
        <td data-label={t("prof_table_updated")} data-column-priority="essential" className={styles.profileDateCell}>
          {profile.updatedAt || profile.createdAt
            ? formatDateTime(profile.updatedAt || profile.createdAt || '')
            : t("prof_governance_not_modified")}
        </td>
        <td data-label={t("actions")} data-column-priority="essential" className={styles.profileTableActions}>
          <button
            type="button"
            className={styles.profileRowAction}
            onClick={() => openTemplate(profile.name)}
            title={archived || !canEditTemplates ? t("prof_view_details") : t("edit")}
            aria-label={`${archived || !canEditTemplates ? t("prof_view_details") : t("edit")}: ${profile.title || profile.name}`}
          >
            {archived || !canEditTemplates ? <Eye size={17} aria-hidden="true" /> : <Pencil size={17} aria-hidden="true" />}
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div className={`container animate-fade-in ${styles.profilePageContainer}`}>
      <PageHeader
        eyebrow={t("eyebrow_policy_template")}
        icon={<Boxes size={23} />}
        title={t("prof_governance_title")}
        description={t("prof_governance_subtitle")}
      />

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
            detailClassName: styles.profileMetricDetail,
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
        <form className={styles.profileSearchForm} role="search" onSubmit={handleSearchSubmit}>
          <input
            type="search"
            className="form-input hover-glass profile-search-input"
            aria-label={t("prof_search_ph")}
            placeholder={t("prof_search_ph")}
            value={searchInput}
            onChange={event => setSearchInput(event.target.value)}
          />
          <button type="submit" className={`btn btn-outline ${styles.profileSearchSubmit}`}>{t("search")}</button>
        </form>
        <div className="profile-domain-filters" role="group" aria-label={t("prof_filter_group")}>
          {FILTER_OPTIONS.map(filter => (
            <button
              key={filter}
              type="button"
              className={`${listFilter === filter ? "btn btn-primary" : "btn btn-outline"} profile-domain-btn`}
              aria-pressed={listFilter === filter}
              onClick={() => handleFilterChange(filter)}
            >
              {t(FILTER_LABEL_KEYS[filter])}
            </button>
          ))}
          <button
            type="button"
            className={`${includeArchived ? "btn btn-primary" : "btn btn-outline"} profile-domain-btn`}
            aria-pressed={includeArchived}
            onClick={() => url.setFilter('archived', includeArchived ? '' : '1')}
          >
            {t('prof_filter_archived')}
          </button>
        </div>
        {canEditTemplates && (
          <div className="page-action-buttons">
            <button className="btn btn-primary" onClick={() => router.push('/profile/new')} title={t("prof_btn_create")}>
              <Plus size={16} /> {t("prof_new_profile")}
            </button>
          </div>
        )}
      </div>

      {bulkNotice && (
        <OperationNotice
          presentation="inline"
          tone={bulkNotice.tone}
          message={bulkNotice.text}
          onClose={() => setBulkNotice(null)}
        />
      )}

      {selectedNames.length > 0 && (
        <div className="page-action-bar" role="group" aria-label={t('prof_bulk_selected', { count: selectedNames.length })}>
          <span className="form-label">{t('prof_bulk_selected', { count: selectedNames.length })}</span>
          <div className="page-action-buttons">
            <button type="button" className="btn btn-outline" onClick={() => { void runBulkExport(); }} disabled={Boolean(bulk)}>
              <Download size={15} /> {t('prof_bulk_export')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setIsBulkDeleteOpen(true)} disabled={Boolean(bulk)}>
              <Trash2 size={15} /> {t('prof_bulk_delete')}
            </button>
            <button type="button" className="btn btn-outline" onClick={clearSelection} disabled={Boolean(bulk)}>
              {t('prof_bulk_clear')}
            </button>
          </div>
        </div>
      )}

      {bulk && (
        <p className="form-label" role="status">
          {t('prof_bulk_progress', { done: bulk.done, total: bulk.total })}
        </p>
      )}

      {isBulkDeleteOpen && (
        <ConfirmActionPanel
          tone="danger"
          title={t('prof_bulk_delete_title', { count: selectedNames.length })}
          message={t('prof_bulk_delete_desc', { count: selectedNames.length })}
          confirmLabel={t('delete')}
          cancelLabel={t('cancel')}
          isWorking={bulk?.kind === 'delete'}
          onConfirm={() => { setIsBulkDeleteOpen(false); void runBulkDelete(); }}
          onCancel={() => setIsBulkDeleteOpen(false)}
        />
      )}

      {isLoading ? (
        <div className={`dash-card ${styles.profileTableState}`}>
          <LoadingRows columns={8} rows={4} />
        </div>
      ) : error ? (
        <div className={`dash-card ${styles.profileTableState}`}>
          <ErrorState
            title={t("prof_err_load")}
            message={error instanceof Error ? error.message : String(error)}
            retryLabel={t("retry")}
            onRetry={() => { void mutate(); }}
          />
        </div>
      ) : profiles.length === 0 ? (
        <div className={`dash-card ${styles.profileTableState}`}>
          <EmptyState
            icon={<Boxes size={48} />}
            title={hasActiveFilter ? t("prof_no_match") : t("prof_empty_list")}
            description={hasActiveFilter ? t("prof_empty_filtered_desc") : t("prof_empty_desc")}
          />
        </div>
      ) : (
        <div className={`dash-card ${styles.profileTableCard}`}>
          <div className={styles.profileTableWrap}>
            <table className={styles.profileGovernanceTable}>
              <caption className="sr-only">{t("prof_governance_title")}</caption>
              <colgroup>
                <col className={styles.profileColSelect} />
                <col className={styles.profileColTemplate} />
                <col className={styles.profileColContent} />
                <col className={styles.profileColLinked} />
                <col className={styles.profileColAmbr} />
                <col className={styles.profileColOwner} />
                <col className={styles.profileColUpdated} />
                <col className={styles.profileColActions} />
              </colgroup>
              <thead>
                <tr>
                  <th className={styles.profileTableSelect}>
                    <input
                      type="checkbox"
                      className="checkbox-custom"
                      aria-label={t('prof_select_all')}
                      checked={profiles.length > 0 && profiles.every((profile) => selectedNames.includes(profile.name))}
                      onChange={(event) => {
                        const pageNames = profiles.map((profile) => profile.name);
                        setSelectedNames(event.target.checked
                          ? Array.from(new Set([...selectedNames, ...pageNames]))
                          : selectedNames.filter((name) => !pageNames.includes(name)));
                      }}
                    />
                  </th>
                  <SortableTableHeader
                    label={t("prof_table_template")}
                    active={sortField === 'name'}
                    direction={sortDirection}
                    icon={renderSortIcon('name')}
                    onSort={() => applySort('name')}
                  />
                  <SortableTableHeader
                    label={t("prof_table_content")}
                    active={sortField === 'sliceCount'}
                    direction={sortDirection}
                    icon={renderSortIcon('sliceCount')}
                    onSort={() => applySort('sliceCount')}
                    priority="important"
                  />
                  <SortableTableHeader
                    label={t("prof_table_linked_users")}
                    active={sortField === 'subscriberCount'}
                    direction={sortDirection}
                    icon={renderSortIcon('subscriberCount')}
                    onSort={() => applySort('subscriberCount')}
                    priority="important"
                    className={styles.profileTableNumber}
                  />
                  <th data-column-priority="supplementary">{t("prof_table_ambr")}</th>
                  <th data-column-priority="supplementary">{t("prof_table_modified_by")}</th>
                  <SortableTableHeader
                    label={t("prof_table_updated")}
                    active={sortField === 'updatedAt'}
                    direction={sortDirection}
                    icon={renderSortIcon('updatedAt')}
                    onSort={() => applySort('updatedAt')}
                  />
                  <th data-column-priority="essential" className={styles.profileTableActionsHeading}>{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => renderProfileRow(profile))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className={styles.profileTableState}>
              <button type="button" className="btn btn-outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t("loading") : t("prof_load_more")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
