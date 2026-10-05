import { useEffect, useState } from 'react';
import { Activity, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../providers/I18nProvider';
import { useNotifications } from '../../providers/NotificationProvider';

type SentinelTone = 'healthy' | 'warning' | 'critical' | 'muted';

function toneFor(criticalCount: number, warningCount: number, status: string): SentinelTone {
  if (status === 'disconnected') return 'muted';
  if (criticalCount > 0) return 'critical';
  if (warningCount > 0) return 'warning';
  return 'healthy';
}

/**
 * Restored header NOC sentinel.
 *
 * It summarises the operational posture derived from the current alert authority
 * (the notification stream projection). When the stream is unavailable the shell
 * shows an explicit neutral state instead of inventing telemetry.
 */
export function NocSentinel() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { notifications, connectionStatus, activeCount, criticalCount, warningCount } = useNotifications();
  const [open, setOpen] = useState(false);
  const tone = toneFor(criticalCount, warningCount, connectionStatus);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const label = connectionStatus === 'disconnected'
    ? t('noc_unavailable')
    : activeCount > 0
      ? t('noc_alerts_active').replace('{count}', String(activeCount))
      : t('noc_all_clear');

  const alertItems = notifications.filter((item) => item.category === 'alert').slice(0, 6);

  return (
    <div className="noc-sentinel">
      <button
        type="button"
        className={`noc-header-button ${tone}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
      >
        <span className="noc-button-icon" aria-hidden="true">
          {tone === 'healthy' ? <ShieldCheck size={16} /> : <Activity size={16} />}
        </span>
        <span className="noc-button-label">{t('noc_sentinel')}</span>
        {activeCount > 0 ? <span className="noc-count">{activeCount > 99 ? '99+' : activeCount}</span> : null}
      </button>

      {open ? (
        <>
          <div className="noc-panel-backdrop" onClick={() => setOpen(false)} />
          <div className="noc-panel" role="dialog" aria-label={t('noc_sentinel')}>
            <div className="noc-panel-header">
              <div>
                <h3><Activity size={16} />{t('noc_sentinel')}</h3>
                <span>{label}</span>
              </div>
              <button type="button" className="noc-ghost-button" onClick={() => { setOpen(false); navigate('/system-health'); }}>
                {t('nav_health')}
              </button>
            </div>

            <div className="noc-workflow-summary">
              <span>{t('noc_critical')}: {criticalCount}</span>
              <span>{t('noc_warning')}: {warningCount}</span>
              <span>{t('noc_total')}: {activeCount}</span>
            </div>

            <div className="noc-alert-list">
              {connectionStatus === 'disconnected' ? (
                <div className="noc-empty">
                  <Activity size={30} />
                  <strong>{t('noc_unavailable')}</strong>
                  <span>{t('noc_unavailable_body')}</span>
                </div>
              ) : alertItems.length === 0 ? (
                <div className="noc-empty">
                  <ShieldCheck size={30} />
                  <strong>{t('noc_all_clear')}</strong>
                  <span>{t('noc_all_clear_body')}</span>
                </div>
              ) : alertItems.map((item) => (
                <div key={item.id} className={`noc-alert ${item.type === 'critical' ? 'critical' : ''}`}>
                  <div className="noc-alert-content">
                    <div className="noc-alert-meta">
                      <span>{new Date(item.timestamp).toLocaleString()}</span>
                    </div>
                    <div className="noc-alert-reason">{item.message}</div>
                    <div className="noc-workflow-row">
                      <span className={`noc-workflow-pill ${item.read ? 'acknowledged' : ''}`}>
                        {item.read ? t('alert_acknowledged') : t('alert_open')}
                      </span>
                      <span>{item.title}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
