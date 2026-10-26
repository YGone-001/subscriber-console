/*
 * Template-to-subscriber consistency probe.
 *
 * A template is copied into a subscriber at apply time and never referenced
 * afterwards, so "linked" alone cannot say whether a subscriber still matches
 * it. This panel asks the server, which compares each subscriber against the
 * same projection the governed apply performs; the client never infers drift.
 */
import { useState } from 'react';
import { GitCompareArrows, RefreshCw } from 'lucide-react';
import { postJson } from '../../../lib/api/mutation-client';

type Translate = (key: string, values?: Record<string, string | number>) => string;

export type ProfileDriftEntry = { imsi: string; state: string; changedGroups?: string[] };

export type ProfileDriftReport = {
  profileName: string;
  checked: number;
  inSync: number;
  changed: number;
  unknown: number;
  truncated: boolean;
  results: ProfileDriftEntry[];
};

const GROUP_LABEL_KEYS: Record<string, string> = {
  security: 'prof_drift_group_security',
  ambr: 'prof_drift_group_ambr',
  slice: 'prof_drift_group_slice',
  access_restriction_data: 'prof_drift_group_access',
  profile_name: 'prof_drift_group_binding',
};

export function ProfileDriftCard({ t, profileName, onRejected }: {
  t: Translate;
  profileName: string;
  onRejected: (message: string) => void;
}) {
  const [report, setReport] = useState<ProfileDriftReport | null>(null);
  const [isProbing, setIsProbing] = useState(false);

  const probe = async () => {
    setIsProbing(true);
    try {
      setReport(await postJson<ProfileDriftReport>(
        `/api/profiles/${encodeURIComponent(profileName)}/drift-precheck`,
        {},
      ));
    } catch (err) {
      onRejected(err instanceof Error ? err.message : t('prof_drift_error'));
    } finally {
      setIsProbing(false);
    }
  };

  const outstanding = (report?.results ?? []).filter((entry) => entry.state !== 'in_sync');

  return (
    <div className="dash-card card-margin-top" id="psec-drift">
      <div className="dash-card-header flex-between-center">
        <div className="flex-center-gap">
          <GitCompareArrows size={20} color="var(--primary)" />
          <div>
            <h3 className="card-title">{t('prof_drift_title')}</h3>
            <p className="profile-drift-desc">{t('prof_drift_desc')}</p>
          </div>
        </div>
        <button type="button" className="btn btn-outline" onClick={() => { void probe(); }} disabled={isProbing}>
          <RefreshCw size={16} /> {isProbing ? t('prof_drift_probing') : t('prof_drift_btn')}
        </button>
      </div>
      {report && (
        <div className="dash-card-body">
          <div className="profile-drift-tally" role="status">
            <span className="profile-drift-tally-item profile-drift-ok">
              {t('prof_drift_in_sync', { count: report.inSync })}
            </span>
            <span className={`profile-drift-tally-item ${report.changed > 0 ? 'profile-drift-warn' : ''}`}>
              {t('prof_drift_changed', { count: report.changed })}
            </span>
            <span className="profile-drift-tally-item">
              {t('prof_drift_unknown', { count: report.unknown })}
            </span>
            {report.truncated && (
              <span className="profile-drift-tally-item profile-drift-warn">{t('prof_drift_truncated')}</span>
            )}
          </div>
          {report.checked === 0 ? (
            /* "all match" would be vacuously true with nothing probed. */
            <p className="text-muted-label">{t('prof_drift_empty')}</p>
          ) : outstanding.length === 0 ? (
            <p className="text-muted-label">{t('prof_drift_none')}</p>
          ) : (
            <ul className="profile-drift-list">
              {outstanding.map((entry) => (
                <li key={`${entry.imsi}-${entry.state}`} className="profile-drift-row">
                  <span className="value-mono">{entry.imsi || t('prof_drift_no_imsi')}</span>
                  <span className="profile-drift-state">
                    {entry.state === 'unknown' ? t('prof_drift_state_unknown') : t('prof_drift_state_changed')}
                  </span>
                  {(entry.changedGroups ?? []).map((group) => (
                    <span key={group} className="profile-chip profile-chip-neutral">
                      {t(GROUP_LABEL_KEYS[group] ?? 'prof_drift_group_other')}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
