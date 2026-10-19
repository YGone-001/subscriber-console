/*
 * Notification settings: channels, escalation rules and recent delivery health.
 *
 * This lives as a secondary settings dialog inside the NF Alert rules view, not
 * as another first-level workbench tab. Channel secrets are write-only: the
 * form accepts them, the server never returns them, so the edit form leaves the
 * secret blank to keep the stored value.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Plus, Trash2, X } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { useI18n } from '../../providers/I18nProvider';
import { useAuth } from '../../providers/AuthProvider';
import { hasPermission } from '../../lib/permissions';
import {
  createNotificationChannel,
  createNotificationEscalation,
  deleteNotificationChannel,
  deleteNotificationEscalation,
  fetchNotificationChannels,
  fetchNotificationDeliveries,
  fetchNotificationEscalations,
} from './nf-notifications-api';
import type {
  Delivery,
  Escalation,
  EscalationSeverity,
  NotificationChannel,
} from './nf-notifications-types';
import styles from '../../styles/modules/nf-alerts.module.css';

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
};

type Tab = 'channels' | 'escalations' | 'deliveries';

const SEVERITIES: EscalationSeverity[] = ['critical', 'warning', 'info'];

export function NotificationSettingsDialog({ open, onClose, onChanged }: Props) {
  const { t } = useI18n();
  const { user } = useAuth();
  const canConfigure = hasPermission(user, 'core.configure');

  const [tab, setTab] = useState<Tab>('channels');
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [channelsRes, escalationsRes, deliveriesRes] = await Promise.allSettled([
      fetchNotificationChannels(),
      fetchNotificationEscalations(),
      fetchNotificationDeliveries(20),
    ]);
    setChannels(channelsRes.status === 'fulfilled' ? channelsRes.value : []);
    setEscalations(escalationsRes.status === 'fulfilled' ? escalationsRes.value : []);
    setDeliveries(deliveriesRes.status === 'fulfilled' ? deliveriesRes.value.deliveries : []);
    if (
      channelsRes.status === 'rejected' &&
      escalationsRes.status === 'rejected' &&
      deliveriesRes.status === 'rejected'
    ) {
      setError(t('nf_notify_load_failed'));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setTab('channels');
    void load();
  }, [open, load]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={t('nf_notify_title')}
      overlayClassName="modal-overlay"
      className="modal-content animate-fade-in"
    >
      <div className={styles.notifyDialog}>
        <header className={styles.drawerHead}>
          <div>
            <h2 className={styles.drawerTitle}>
              <Bell size={18} aria-hidden="true" />
              {t('nf_notify_title')}
            </h2>
            <p className={styles.drawerSub}>{t('nf_notify_hint')}</p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label={t('close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <nav className={styles.notifyTabs} role="tablist" aria-label={t('nf_notify_title')}>
          {(['channels', 'escalations', 'deliveries'] as Tab[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={tab === option}
              data-notify-tab={option}
              className={tab === option ? styles.viewToggleActive : undefined}
              onClick={() => setTab(option)}
            >
              {t(`nf_notify_tab_${option}`)}
            </button>
          ))}
        </nav>

        {error ? <p className={styles.probeEditorEmpty}>{error}</p> : null}

        {tab === 'channels' ? (
          <ChannelSection channels={channels} loading={loading} canConfigure={canConfigure} onChanged={onChanged} onReload={load} />
        ) : tab === 'escalations' ? (
          <EscalationSection
            escalations={escalations}
            channels={channels}
            loading={loading}
            canConfigure={canConfigure}
            onChanged={onChanged}
            onReload={load}
          />
        ) : (
          <DeliverySection deliveries={deliveries} channels={channels} />
        )}
      </div>
    </Dialog>
  );
}

function ChannelSection({
  channels,
  loading,
  canConfigure,
  onChanged,
  onReload,
}: {
  channels: NotificationChannel[];
  loading: boolean;
  canConfigure: boolean;
  onChanged: () => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await createNotificationChannel({ name: name.trim(), kind: 'webhook', url: url.trim(), secret });
      setName('');
      setUrl('');
      setSecret('');
      onChanged();
      onReload();
    } catch {
      /* the page-level feedback already surfaces failures */
    } finally {
      setBusy(false);
    }
  };

  const remove = async (channel: NotificationChannel) => {
    await deleteNotificationChannel(channel.id);
    onChanged();
    onReload();
  };

  return (
    <div className={styles.notifySection}>
      {canConfigure ? (
        <form className={styles.notifyForm} onSubmit={submit}>
          <Field htmlFor="notify-channel-name" label={t('nf_notify_channel_name')}>
            <input id="notify-channel-name" className="form-input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('nf_notify_channel_name_placeholder')} />
          </Field>
          <Field htmlFor="notify-channel-url" label={t('nf_notify_channel_url')}>
            <input id="notify-channel-url" className="form-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://hooks.example.com/alert" />
          </Field>
          <Field htmlFor="notify-channel-secret" label={t('nf_notify_channel_secret')} description={t('nf_notify_channel_secret_hint')}>
            <input id="notify-channel-secret" className="form-input" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={busy || loading}>
            <Plus size={14} aria-hidden="true" />
            {t('nf_notify_channel_add')}
          </button>
        </form>
      ) : null}

      {channels.length === 0 && !loading ? (
        <p className={styles.probeEditorEmpty}>{t('nf_notify_channels_empty')}</p>
      ) : (
        <ul className={styles.notifyList}>
          {channels.map((channel) => (
            <li key={channel.id} className={styles.notifyRow} data-notify-channel={channel.id}>
              <div className={styles.stack}>
                <strong>{channel.name}</strong>
                <code className={styles.uuid}>{channel.url}</code>
              </div>
              <span className={channel.enabled ? styles.badgeHealthy : styles.badgeNotConfigured}>
                {channel.enabled ? t('nf_notify_enabled') : t('nf_notify_disabled')}
              </span>
              {canConfigure ? (
                <button type="button" className="btn btn-ghost" onClick={() => void remove(channel)} aria-label={t('nf_notify_channel_remove')}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EscalationSection({
  escalations,
  channels,
  loading,
  canConfigure,
  onChanged,
  onReload,
}: {
  escalations: Escalation[];
  channels: NotificationChannel[];
  loading: boolean;
  canConfigure: boolean;
  onChanged: () => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [severities, setSeverities] = useState<EscalationSeverity[]>(['critical']);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [delay, setDelay] = useState(0);
  const [escalateChannelIds, setEscalateChannelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const toggle = (list: EscalationSeverity[], value: EscalationSeverity) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || channelIds.length === 0) return;
    setBusy(true);
    try {
      await createNotificationEscalation({
        name: name.trim(),
        severities,
        channelIds,
        escalateAfterSeconds: delay,
        escalateChannelIds: delay > 0 ? escalateChannelIds : undefined,
      });
      setName('');
      setSeverities(['critical']);
      setChannelIds([]);
      setDelay(0);
      setEscalateChannelIds([]);
      onChanged();
      onReload();
    } catch {
      /* surfaced by page feedback */
    } finally {
      setBusy(false);
    }
  };

  const remove = async (escalation: Escalation) => {
    await deleteNotificationEscalation(escalation.id);
    onChanged();
    onReload();
  };

  return (
    <div className={styles.notifySection}>
      {canConfigure ? (
        <form className={styles.notifyForm} onSubmit={submit}>
          <Field htmlFor="notify-escalation-name" label={t('nf_notify_escalation_name')}>
            <input id="notify-escalation-name" className="form-input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('nf_notify_escalation_name_placeholder')} />
          </Field>
          <Field htmlFor="notify-escalation-severities" label={t('nf_notify_escalation_severities')}>
            <div className={styles.notifyChecks}>
              {SEVERITIES.map((severity) => (
                <label key={severity} className={styles.notifyCheck}>
                  <input
                    type="checkbox"
                    checked={severities.includes(severity)}
                    onChange={() => setSeverities((current) => toggle(current, severity))}
                  />
                  {t(`nf_alerts_severity_${severity}`)}
                </label>
              ))}
            </div>
          </Field>
          <Field htmlFor="notify-escalation-channels" label={t('nf_notify_escalation_channels')}>
            <select
              id="notify-escalation-channels"
              className="form-input"
              multiple
              value={channelIds}
              onChange={(event) => setChannelIds(Array.from(event.target.selectedOptions, (option) => option.value))}
            >
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>{channel.name}</option>
              ))}
            </select>
          </Field>
          <Field htmlFor="notify-escalation-delay" label={t('nf_notify_escalation_delay')} description={t('nf_notify_escalation_delay_hint')}>
            <input
              id="notify-escalation-delay"
              className="form-input"
              type="number"
              min={0}
              value={delay}
              onChange={(event) => setDelay(Number(event.target.value) || 0)}
            />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={busy || loading || channels.length === 0}>
            <Plus size={14} aria-hidden="true" />
            {t('nf_notify_escalation_add')}
          </button>
        </form>
      ) : null}

      {escalations.length === 0 && !loading ? (
        <p className={styles.probeEditorEmpty}>{t('nf_notify_escalations_empty')}</p>
      ) : (
        <ul className={styles.notifyList}>
          {escalations.map((escalation) => (
            <li key={escalation.id} className={styles.notifyRow} data-notify-escalation={escalation.id}>
              <div className={styles.stack}>
                <strong>{escalation.name}</strong>
                <span className={styles.uuid}>
                  {escalation.severities.join(', ')} {t('nf_notify_to')} {escalation.channelIds.length}
                  {escalation.escalateAfterSeconds > 0
                    ? ` - ${t('nf_notify_escalate_after')} ${escalation.escalateAfterSeconds}s`
                    : ''}
                </span>
              </div>
              <span className={escalation.enabled ? styles.badgeHealthy : styles.badgeNotConfigured}>
                {escalation.enabled ? t('nf_notify_enabled') : t('nf_notify_disabled')}
              </span>
              {canConfigure ? (
                <button type="button" className="btn btn-ghost" onClick={() => void remove(escalation)} aria-label={t('nf_notify_escalation_remove')}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeliverySection({ deliveries, channels }: { deliveries: Delivery[]; channels: NotificationChannel[] }) {
  const { t } = useI18n();
  const channelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const channel of channels) map.set(channel.id, channel.name);
    return map;
  }, [channels]);

  if (deliveries.length === 0) {
    return <p className={styles.probeEditorEmpty}>{t('nf_notify_deliveries_empty')}</p>;
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table} data-notify-deliveries="true">
        <caption className="sr-only">{t('nf_notify_deliveries_caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('nf_notify_col_event')}</th>
            <th scope="col">{t('nf_notify_col_target')}</th>
            <th scope="col">{t('nf_notify_col_channel')}</th>
            <th scope="col">{t('nf_notify_col_status')}</th>
            <th scope="col">{t('nf_notify_col_attempts')}</th>
            <th scope="col">{t('nf_notify_col_time')}</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => (
            <tr key={delivery.id} data-notify-delivery={delivery.id}>
              <td><span className={styles.chip}>{delivery.event}</span></td>
              <td>{delivery.targetName}</td>
              <td>{channelNames.get(delivery.channelId) ?? delivery.channelId}</td>
              <td>{t(`nf_notify_status_${delivery.status}`)}</td>
              <td>{delivery.attempts}</td>
              <td>{delivery.occurredAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
