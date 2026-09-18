"use client";

import { useI18n } from '@/components/I18nProvider';
import { formatGovernanceTime } from '@/lib/governance/display';
import type { GovernanceEvent } from '@/types/governance';
import styles from './governance.module.css';

export function EventTimeline({ events, timeZone = 'Asia/Shanghai' }: { events: readonly GovernanceEvent[]; timeZone?: string }) {
  const { t } = useI18n();
  if (!events.length) return <p className={styles.muted}>{t('governance_events_empty')}</p>;
  // The caller supplies recorded events in order, never synthesized status steps.
  return <ol className={styles.timeline} aria-label={t('governance_timeline')}>
    {events.map((event, index) => <li key={event.id || `${event.timestamp}:${event.type}:${index}`}>
      <time dateTime={event.timestamp} title={`${event.timestamp} · ${timeZone}`}>
        {formatGovernanceTime(event.timestamp, timeZone)}
      </time>
      <div>{event.actor ? <strong>{event.actor} · </strong> : null}{event.message}</div>
    </li>)}
  </ol>;
}
