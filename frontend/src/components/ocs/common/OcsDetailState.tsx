/*
 * OCS detail-page state panel.
 *
 * The detail pages used to render every failure as "not found", including a
 * network outage, a denied permission and a 500. Those are different situations
 * with different next actions, so they get different panels: "not found" offers
 * a way back to the list, "error" offers a retry, "forbidden" explains the
 * permission, and "loading" keeps the page geometry stable.
 */
import { AlertTriangle, Loader2, Lock, SearchX } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../../providers/I18nProvider';

export type OcsDetailStateKind = 'loading' | 'error' | 'notFound' | 'forbidden';

interface OcsDetailStateProps {
  kind: OcsDetailStateKind;
  /** Optional diagnostic detail. Never used as the primary message. */
  detail?: string;
  onRetry?: () => void;
  backTo?: { to: string; label: string };
}

export default function OcsDetailState({ kind, detail, onRetry, backTo }: OcsDetailStateProps) {
  const { t } = useI18n();

  if (kind === 'loading') {
    return (
      <div className="ocs-detail-state" role="status" aria-live="polite">
        <Loader2 size={18} className="spin" aria-hidden="true" />
        <span>{t('loading')}</span>
      </div>
    );
  }

  if (kind === 'notFound') {
    return (
      <div className="ocs-detail-state" data-state="not-found" role="status">
        <SearchX size={20} aria-hidden="true" />
        <span>{t('ocs_detail_not_found')}</span>
        {backTo ? (
          <Link className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto" to={backTo.to}>
            {backTo.label}
          </Link>
        ) : null}
      </div>
    );
  }

  if (kind === 'forbidden') {
    return (
      <div className="ocs-detail-state" data-state="forbidden" role="alert">
        <Lock size={20} aria-hidden="true" />
        <span>{t('ocs_detail_forbidden')}</span>
      </div>
    );
  }

  return (
    <div className="ocs-detail-state" data-state="error" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <span>{t('ocs_detail_load_failed')}</span>
      {detail ? <span className="ocs-detail-state-detail">{detail}</span> : null}
      {onRetry ? (
        <button type="button" className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto" onClick={onRetry}>
          {t('ocs_retry')}
        </button>
      ) : null}
      {backTo ? (
        <Link className="ocs-btn ocs-btn-secondary ocs-btn-compact-auto" to={backTo.to}>
          {backTo.label}
        </Link>
      ) : null}
    </div>
  );
}
