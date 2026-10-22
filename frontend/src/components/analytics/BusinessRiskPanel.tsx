/*
 * Business risk queue.
 *
 * Replaces the legacy synthetic readiness score. Every entry is derived from a
 * named check over real OCS data; a missing measurement becomes an explicit
 * data-gap risk, never a passing check.
 */
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Info, ListChecks, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import type { BusinessRisk } from './types';

const MAX_VISIBLE = 5;

export default function BusinessRiskPanel({ risks, total }: { risks: BusinessRisk[]; total: number }) {
  const { t, formatNumber } = useI18n();
  const visible = risks.slice(0, MAX_VISIBLE);

  return (
    <section className="analytics-panel analytics-risk-panel" aria-labelledby="business-risk-title">
      <div className="analytics-panel-header">
        <div className="analytics-panel-title">
          <ListChecks size={18} color="var(--primary)" />
          <h2 id="business-risk-title">{t('dash_biz_risk_title')}</h2>
        </div>
        <span className="analytics-panel-badge">{formatNumber(total)}</span>
      </div>

      <div className="analytics-risk-body">
        <p className="analytics-risk-note">{t('dash_biz_risk_note')}</p>

        {visible.length === 0 ? (
          <div className="analytics-risk-empty">
            <ShieldCheck size={22} color="var(--status-success)" />
            <div>
              <strong>{t('dash_biz_risk_empty')}</strong>
              <span>{t('dash_biz_risk_empty_detail')}</span>
            </div>
          </div>
        ) : (
          <ul className="analytics-risk-list">
            {visible.map((risk) => (
              <li key={risk.id}>
                <Link to={risk.href} className={`analytics-risk-item analytics-risk-${risk.tone}`}>
                  <span className="analytics-risk-icon" aria-hidden="true">
                    {risk.tone === 'danger'
                      ? <AlertTriangle size={15} />
                      : risk.tone === 'warning'
                        ? <AlertCircle size={15} />
                        : <Info size={15} />}
                  </span>
                  <span className="analytics-risk-copy">
                    <strong>{risk.title}</strong>
                    <span>{risk.detail}</span>
                  </span>
                  <span className="analytics-risk-severity">
                    {t(risk.tone === 'danger'
                      ? 'dash_biz_risk_high'
                      : risk.tone === 'warning'
                        ? 'dash_biz_risk_attention'
                        : 'dash_biz_risk_info')}
                  </span>
                  <span className="analytics-risk-action">{risk.action}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {total > visible.length ? (
          <p className="analytics-risk-more">{t('dash_biz_risk_more', { count: formatNumber(total - visible.length) })}</p>
        ) : null}

        <p className="analytics-risk-checks">{t('dash_biz_risk_checks')}</p>
      </div>
    </section>
  );
}
