/*
 * Version history for one template: list, snapshot comparison and the restore
 * affordance. The snapshot is fetched by id from the endpoint that serves it.
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp, GitCompareArrows, History, RotateCcw } from 'lucide-react';
import { getJson } from '../../../lib/api/read-client';
import { buildProfileVersionDiff } from '../profile-version-diff';
import type { ProfileRecord, ProfileVersionDetail, ProfileVersionSummary } from '../profile-types';

type Translate = (key: string, values?: Record<string, string | number>) => string;

type Props = {
  t: Translate;
  formatDateTime: (value: string) => string;
  profileName: string;
  versions: ProfileVersionSummary[];
  currentProfile: ProfileRecord | null;
  isLoading: boolean;
  error: unknown;
  canRestore: boolean;
  onRefresh: () => void;
  onRestore: (version: ProfileVersionDetail) => void;
};

export function ProfileVersionsCard({
  t,
  formatDateTime,
  profileName,
  versions,
  currentProfile,
  isLoading,
  error,
  canRestore,
  onRefresh,
  onRestore,
}: Props) {
  const [selectedVersion, setSelectedVersion] = useState<ProfileVersionDetail | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const openVersion = async (versionId: string) => {
    setIsDetailLoading(true);
    setDetailError(null);
    try {
      const data = await getJson<{ version?: ProfileVersionDetail }>(
        `/api/profiles/${encodeURIComponent(profileName)}/versions?versionId=${encodeURIComponent(versionId)}`,
      );
      if (!data.version) throw new Error(t('prof_version_err_load'));
      setSelectedVersion(data.version);
    } catch (err) {
      setSelectedVersion(null);
      setDetailError(err instanceof Error ? err.message : t('prof_version_err_load'));
    } finally {
      setIsDetailLoading(false);
    }
  };

  const diffSections = selectedVersion
    ? buildProfileVersionDiff(selectedVersion.profile, currentProfile, {
      notConfigured: t('prof_diff_not_configured'),
      sliceUnit: t('prof_version_slices'),
      sessionUnit: t('prof_diff_session_unit'),
      pccUnit: t('prof_diff_pcc_unit'),
      accessNone: t('prof_diff_access_none'),
      accessSuspended: t('prof_diff_access_suspended'),
      maskedSecret: t('prof_diff_masked'),
      withheld: t('credential_withheld'),
    })
    : [];
  const changedSectionCount = diffSections.filter((section) => section.changed).length;

  return (
    <div className="dash-card animate-fade-in pm-card" id="psec-versions">
      <div className="dash-card-header pm-card-header">
        <div className="pm-card-header-left">
          <History size={20} color="var(--primary)" />
          <div>
            <h3 className="pm-card-header-title">{t('prof_version_title')}</h3>
            <p className="pm-card-header-desc">{t('prof_version_desc')}</p>
          </div>
        </div>
        <div className="pm-card-header-actions">
          <span className="pm-version-count" aria-label={t('prof_version_entries', { count: versions.length })}>
            {versions.length}
          </span>
          {open && (
            <button className="btn btn-outline pm-refresh-btn" onClick={onRefresh} disabled={isLoading}>
              {isLoading ? t('prof_version_loading') : t('audit_refresh')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-outline pm-version-toggle"
            aria-expanded={open}
            aria-controls="psec-versions-body"
            onClick={() => setOpen((prev) => !prev)}
          >
            {open ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            {t(open ? 'collapse' : 'expand')}
          </button>
        </div>
      </div>
      {open && (
      <div className="dash-card-body pm-card-body" id="psec-versions-body">
        <div className="pm-versions-list">
          {error ? (
            <div className="pm-versions-empty">{t('prof_version_err_load')}</div>
          ) : versions.length === 0 ? (
            <div className="pm-versions-empty">
              {isLoading ? t('prof_version_loading') : t('prof_version_empty')}
            </div>
          ) : versions.map((version) => (
            <button
              key={version.versionId}
              type="button"
              onClick={() => { void openVersion(version.versionId); }}
              className={`pm-version-btn ${selectedVersion?.versionId === version.versionId ? 'selected' : ''}`}
            >
              <div className="pm-version-btn-top">
                <strong className="pm-version-btn-title">{t(`prof_version_action_${version.action}`)}</strong>
                <span className="pm-version-btn-slices">{version.sliceCount ?? 0} {t('prof_version_slices')}</span>
              </div>
              <div className="pm-version-btn-time">{formatDateTime(version.savedAt || '')}</div>
              <div className="pm-version-btn-by">{t('prof_version_by')} {version.savedBy || ''}</div>
            </button>
          ))}
        </div>

        <div className="pm-version-diff">
          {!selectedVersion ? (
            <div className="pm-version-diff-empty">
              {isDetailLoading ? t('prof_version_loading') : detailError || t('prof_version_select')}
            </div>
          ) : (
            <div className="pm-version-diff-body">
              <div className="pm-version-diff-header">
                <div>
                  <div className="pm-version-diff-title">
                    <GitCompareArrows size={16} color="var(--primary)" />
                    {t('prof_version_diff')}
                  </div>
                  <div className="pm-version-diff-meta">
                    {t(`prof_version_action_${selectedVersion.action}`)} · {formatDateTime(selectedVersion.savedAt || '')} · {selectedVersion.savedBy || ''}
                  </div>
                </div>
                {canRestore && (
                  <button className="btn btn-primary pm-restore-btn" onClick={() => onRestore(selectedVersion)}>
                    <RotateCcw size={14} /> {t('prof_version_restore')}
                  </button>
                )}
              </div>
              {changedSectionCount === 0 ? (
                <p className="pm-diff-summary-note">{t('prof_version_no_changes')}</p>
              ) : (
                <div className="pm-version-diff-sections">
                  <div className="pm-diff-columns" aria-hidden="true">
                    <span />
                    <span>{t('prof_diff_version_col')}</span>
                    <span>{t('prof_diff_current_col')}</span>
                  </div>
                  {diffSections.map((section) => (
                    <details key={section.key} className={`pm-diff-section ${section.changed ? 'changed' : ''}`} open={section.changed}>
                      <summary>
                        <span className="pm-diff-section-title">{t(section.labelKey)}</span>
                        <strong className={section.changed ? 'pm-confirm-diff-changed' : 'pm-confirm-diff-unchanged'}>
                          {section.changed ? t('prof_version_changed') : t('prof_version_unchanged')}
                        </strong>
                      </summary>
                      <div className="pm-diff-rows">
                        {section.rows.map((row) => (
                          <div key={row.key} className={`pm-diff-row ${row.changed ? 'changed' : ''}`}>
                            <span className="pm-diff-row-label">
                              {row.labelParams ? t(row.labelKey, row.labelParams) : t(row.labelKey)}
                            </span>
                            <span className="pm-diff-row-value">{row.versionValue}</span>
                            <span className="pm-diff-row-value">{row.currentValue}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
