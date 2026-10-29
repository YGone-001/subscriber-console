import { useMemo, useState } from 'react';
import { DatabaseBackup, ShieldAlert } from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import { ErrorState } from '../../components/ui/StatePanel';
import { OperationNotice } from '../../components/ui/OperationFeedback';
import { useRead } from '../../lib/api/use-read';
import { postJson } from '../../lib/api/mutation-client';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { isAdmin } from '../../lib/permissions';

type RetentionSettings = {
  retentionDays: number;
  enabled: boolean;
  cutoff?: string;
  confirmation: string;
};

type Candidate = {
  imsi: string;
  terminatedAt: string;
  ageDays: number;
};

type Preview = {
  settings: RetentionSettings;
  eligibleCount: number;
  candidates: Candidate[];
};

type PurgeResult = {
  requested: number;
  purgedContracts: number;
  purgedBalances: number;
  purgedAdjustments: number;
  skipped: string[];
  warnings: string[];
};

type DryRunResponse = { dryRun: true; preview?: Preview; candidate?: Candidate | null };
type ApplyResponse = { dryRun: false; result: PurgeResult };

export function RetentionPage() {
  const { t, formatDateTime } = useI18n();
  const { user } = useAuth();
  const authorized = isAdmin(user?.role);
  const { data, error, isLoading, mutate } = useRead<Preview>(authorized ? '/api/system/retention/ocs' : null);
  const [dryRun, setDryRun] = useState<Preview | null>(null);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [working, setWorking] = useState<'dry' | 'apply' | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const settings = data?.settings;
  const candidates = dryRun?.candidates ?? data?.candidates ?? [];
  const eligibleCount = dryRun?.eligibleCount ?? data?.eligibleCount ?? 0;
  const applyReady = Boolean(
    settings?.enabled
      && dryRun
      && reason.trim()
      && confirmation.trim() === settings.confirmation,
  );

  const notice = useMemo(() => {
    if (!feedback) return null;
    return (
      <OperationNotice
        presentation="inline"
        tone={feedback.tone}
        message={feedback.text}
        onClose={() => setFeedback(null)}
      />
    );
  }, [feedback]);

  if (!authorized) {
    return (
      <div className="container animate-fade-in">
        <div className="dash-card">
          <div className="dash-card-body">
            <ShieldAlert size={22} aria-hidden="true" /> {t('retention_admin_only')}
          </div>
        </div>
      </div>
    );
  }

  const runDryRun = async () => {
    setWorking('dry');
    setFeedback(null);
    try {
      const response = await postJson<DryRunResponse>('/api/system/retention/ocs/purge', { apply: false, limit: 100 });
      const preview = response.preview ?? {
        settings: settings!,
        eligibleCount: response.candidate ? 1 : 0,
        candidates: response.candidate ? [response.candidate] : [],
      };
      setDryRun(preview);
      setFeedback({ tone: 'success', text: t('retention_dry_run_done', { count: preview.eligibleCount }) });
    } catch (failure) {
      setFeedback({ tone: 'danger', text: failure instanceof Error ? failure.message : t('retention_error') });
    } finally {
      setWorking(null);
    }
  };

  const runApply = async () => {
    if (!dryRun) {
      setFeedback({ tone: 'danger', text: t('retention_apply_requires_dry_run') });
      return;
    }
    if (confirmation.trim() !== settings?.confirmation) {
      setFeedback({ tone: 'danger', text: t('retention_confirm_mismatch') });
      return;
    }
    setWorking('apply');
    setFeedback(null);
    try {
      const response = await postJson<ApplyResponse>('/api/system/retention/ocs/purge', {
        apply: true,
        reason: reason.trim(),
        confirmation: confirmation.trim(),
        limit: 100,
      });
      const result = response.result;
      const warnings = result.warnings.length > 0
        ? ` ${t('retention_audit_warnings', { count: result.warnings.length })}`
        : '';
      setFeedback({
        tone: result.warnings.length > 0 ? 'danger' : 'success',
        text: `${t('retention_apply_done', {
          contracts: result.purgedContracts,
          balances: result.purgedBalances,
          adjustments: result.purgedAdjustments,
        })}${warnings}`,
      });
      setDryRun(null);
      setReason('');
      setConfirmation('');
      await mutate();
    } catch (failure) {
      setFeedback({ tone: 'danger', text: failure instanceof Error ? failure.message : t('retention_error') });
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('nav_platform')}
        icon={<DatabaseBackup size={23} />}
        title={t('retention_title')}
        description={t('retention_subtitle')}
      />

      {notice}

      {isLoading ? (
        <div className="dash-card"><div className="dash-card-body">{t('loading')}</div></div>
      ) : error && !data ? (
        <div className="dash-card">
          <ErrorState
            title={t('retention_error')}
            message={error instanceof Error ? error.message : String(error)}
            retryLabel={t('retry')}
            onRetry={() => { void mutate(); }}
          />
        </div>
      ) : settings ? (
        <>
          <div className="dash-card">
            <div className="dash-card-body">
              <p>
                <strong>{t('retention_days')}:</strong> {settings.retentionDays}{' '}
                <span className={settings.enabled ? 'status-badge active' : 'status-badge suspended'}>
                  {settings.enabled ? t('retention_enabled') : t('retention_disabled')}
                </span>
              </p>
              {settings.cutoff && <p>{t('retention_cutoff')}: {formatDateTime(settings.cutoff)}</p>}
              {!settings.enabled && <p className="warning-text">{t('retention_disabled_hint')}</p>}
              <p>
                <strong>{t('retention_eligible')}:</strong> {eligibleCount}
              </p>
            </div>
          </div>

          <div className="dash-card">
            <div className="dash-card-body">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => { void runDryRun(); }}
                disabled={working !== null}
              >
                {working === 'dry' ? t('loading') : t('retention_dry_run')}
              </button>
              {candidates.length === 0 ? (
                <p className="ocs-empty">{t('retention_empty')}</p>
              ) : (
                <div className="ocs-table-wrap" style={{ marginTop: 12 }}>
                  <table className="ocs-table">
                    <thead>
                      <tr>
                        <th>{t('retention_candidate_imsi')}</th>
                        <th>{t('retention_candidate_terminated')}</th>
                        <th>{t('retention_candidate_age')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((candidate) => (
                        <tr key={candidate.imsi}>
                          <td className="ocs-mono">{candidate.imsi}</td>
                          <td>{candidate.terminatedAt ? formatDateTime(candidate.terminatedAt) : '—'}</td>
                          <td>{candidate.ageDays}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="dash-card">
            <div className="dash-card-body">
              <label className="form-label" htmlFor="retention-reason">{t('retention_reason')}</label>
              <input
                id="retention-reason"
                className="form-input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('retention_reason_ph')}
                maxLength={200}
              />
              <label className="form-label" htmlFor="retention-confirmation">{t('retention_confirm_label')}</label>
              <input
                id="retention-confirmation"
                className="form-input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={settings.confirmation}
                autoComplete="off"
              />
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => { void runApply(); }}
                disabled={working !== null || !applyReady}
                title={!dryRun ? t('retention_apply_requires_dry_run') : undefined}
              >
                {working === 'apply' ? t('loading') : t('retention_apply')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
