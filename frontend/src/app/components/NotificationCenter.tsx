import { useEffect, useState } from 'react';
import { AlertOctagon, AlertTriangle, Bell, CheckCheck, ExternalLink, Info, Radio, ShieldAlert, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../providers/I18nProvider';
import { useNotifications, type NotificationCategory, type NotificationItem } from '../../providers/NotificationProvider';

const SOUND_PREFERENCE_KEY = 'XCLOUD_NOTIF_SOUND';
const VOLUME_PREFERENCE_KEY = 'XCLOUD_NOTIF_VOLUME';

/** Sound and desktop preferences are presentation-local; they never gate delivery. */
function readSoundPreference(): boolean {
  try { return localStorage.getItem(SOUND_PREFERENCE_KEY) === 'on'; } catch { return false; }
}

function readVolumePreference(): number {
  try {
    const stored = Number(localStorage.getItem(VOLUME_PREFERENCE_KEY));
    return Number.isFinite(stored) && stored > 0 && stored <= 1 ? stored : 0.6;
  } catch { return 0.6; }
}

function iconFor(item: NotificationItem) {
  if (item.type === 'critical') return <AlertOctagon size={16} className="notif-type-icon critical" />;
  if (item.type === 'warning') return <AlertTriangle size={16} className="notif-type-icon warning" />;
  return <Info size={16} className="notif-type-icon info" />;
}

/**
 * Restored notification centre.
 *
 * Reads the current notification stream projection only. It separates alert
 * notifications (backend alert authority) from system notices and never
 * conflates them with transient toasts.
 */
export function NotificationCenter() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const {
    notifications, unreadCount, connectionStatus,
    markAsRead, markAllAsRead, clearAllNotifications,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'all' | NotificationCategory>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(readSoundPreference);
  const [soundVolume, setSoundVolume] = useState(readVolumePreference);
  const [desktopPermission, setDesktopPermission] = useState<string>(() => (
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  ));

  useEffect(() => {
    try { localStorage.setItem(SOUND_PREFERENCE_KEY, soundEnabled ? 'on' : 'off'); } catch { /* optional */ }
  }, [soundEnabled]);

  useEffect(() => {
    try { localStorage.setItem(VOLUME_PREFERENCE_KEY, String(soundVolume)); } catch { /* optional */ }
  }, [soundVolume]);

  const requestDesktopPermission = async () => {
    if (typeof Notification === 'undefined') return;
    try { setDesktopPermission(await Notification.requestPermission()); } catch { /* denied */ }
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const filtered = notifications.filter((item) => tab === 'all' || item.category === tab);

  return (
    <div className="notif-center-menu">
      <button
        type="button"
        className="icon-button notif-bell-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('notif_center_title')}
      >
        <Bell size={19} />
        {unreadCount > 0 ? <span className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
        <span className={`notif-status-dot ${connectionStatus}`} title={`${t('notif_live_stream')}: ${connectionStatus}`} />
      </button>

      {open ? (
        <>
          <div className="dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-dropdown-panel animate-pop-in" role="dialog" aria-label={t('notif_center_title')}>
            <div className="notif-panel-header">
              <div className="notif-header-title">
                <strong>{t('notif_center_title')}</strong>
                <span className="notif-stream-badge">
                  <Radio size={12} className={connectionStatus === 'connected' ? 'stream-pulse' : ''} />
                  {connectionStatus === 'connected' ? t('notif_stream_live') : t('notif_stream_reconnecting')}
                </span>
              </div>
              <div className="notif-header-actions">
                <button
                  type="button"
                  className="notif-tool-btn"
                  onClick={() => setSettingsOpen((value) => !value)}
                  aria-expanded={settingsOpen}
                  title={t('notif_settings')}
                >
                  {soundEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>
                {unreadCount > 0 ? (
                  <button type="button" className="notif-tool-btn" onClick={markAllAsRead} title={t('notif_mark_all_read')}>
                    <CheckCheck size={16} />
                  </button>
                ) : null}
              </div>
            </div>

            {settingsOpen ? (
              <div className="notif-settings-drawer">
                <div className="notif-setting-row">
                  <span>{t('notif_sound_alerts')}</span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={(event) => setSoundEnabled(event.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {soundEnabled ? (
                  <div className="notif-setting-row">
                    <span>{t('notif_volume')}: {Math.round(soundVolume * 100)}%</span>
                    <input
                      type="range"
                      min="0.1"
                      max="1"
                      step="0.05"
                      value={soundVolume}
                      onChange={(event) => setSoundVolume(parseFloat(event.target.value))}
                      className="notif-vol-slider"
                      aria-label={t('notif_volume')}
                    />
                  </div>
                ) : null}

                {desktopPermission !== 'granted' ? (
                  <div className="notif-setting-row">
                    <button
                      type="button"
                      className="btn btn-outline notif-desktop-btn"
                      onClick={() => void requestDesktopPermission()}
                    >
                      <ShieldAlert size={14} />
                      {t('notif_enable_desktop')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="notif-tabs">
              <button type="button" className={`notif-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
                {t('notif_tab_all')}
                <span className="notif-tab-count">{notifications.length}</span>
              </button>
              <button type="button" className={`notif-tab ${tab === 'alert' ? 'active' : ''}`} onClick={() => setTab('alert')}>
                {t('notif_tab_alerts')}
              </button>
              <button type="button" className={`notif-tab ${tab === 'system' ? 'active' : ''}`} onClick={() => setTab('system')}>
                {t('notif_tab_system')}
              </button>
            </div>

            <div className="notif-list">
              {filtered.length === 0 ? (
                <div className="notif-empty-state">
                  <Bell size={24} className="notif-empty-icon" />
                  <p>{t('notif_empty')}</p>
                </div>
              ) : filtered.map((item) => (
                <div
                  key={item.id}
                  className={`notif-card ${item.read ? '' : 'unread'}`}
                  onClick={() => {
                    markAsRead(item.id);
                    if (item.link) { setOpen(false); navigate(item.link); }
                  }}
                >
                  <div className="notif-card-icon">{iconFor(item)}</div>
                  <div className="notif-card-body">
                    <div className="notif-card-top">
                      <strong className="notif-card-title">{item.title}</strong>
                      <time className="notif-card-time">
                        {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </time>
                    </div>
                    <p className="notif-card-msg">{item.message}</p>
                    {item.link ? (
                      <div className="notif-card-link">
                        <span>{t('notif_view_details')}</span>
                        <ExternalLink size={12} />
                      </div>
                    ) : null}
                  </div>
                  {item.read ? null : <span className="notif-unread-dot" />}
                </div>
              ))}
            </div>

            {notifications.length > 0 ? (
              <div className="notif-panel-footer">
                <button type="button" className="notif-clear-btn" onClick={clearAllNotifications}>
                  <Trash2 size={13} />
                  {t('notif_clear_all')}
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
