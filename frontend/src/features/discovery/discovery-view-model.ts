/*
 * Discovery view model shared by the exclusive page views.
 *
 * The observation plane keeps three facts separate and never collapses them:
 * NRF registry status, the observation state, and the monitoring association
 * of the linked Inventory resource. These helpers project all three without
 * turning any of them into an operational health flag.
 */
import { MutationApiError } from '../../lib/api/mutation-client';
import type {
  CandidateMonitoringState,
  DiscoveryObservationState,
  NfObservation,
} from './discovery-types';

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export function describeLoadError(err: unknown, t: Translate): string {
  return err instanceof Error && err.message ? err.message : t('discovery_err_load');
}

export function describeMutationError(err: unknown, t: Translate): string {
  if (err instanceof Error && err.message && !err.message.startsWith('{')) {
    if (err.message.startsWith('discovery_validation_')) {
      return t(err.message);
    }
  }
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'DISCOVERY_TARGET_NOT_ALLOWED':
        return t('discovery_err_not_allowed');
      case 'DISCOVERY_SOURCE_DISABLED':
        return t('discovery_err_disabled');
      case 'DISCOVERY_SCAN_IN_PROGRESS':
        return t('discovery_err_scan_in_progress');
      case 'DISCOVERY_SCAN_RATE_LIMITED':
        return t('discovery_err_scan_rate_limited');
      case 'DISCOVERY_REVISION_CONFLICT':
        return t('discovery_err_revision_conflict');
      case 'DISCOVERY_INVENTORY_LINK_CONFLICT':
        return t('discovery_err_link_conflict');
      case 'DISCOVERY_SOURCE_NOT_FOUND':
        return t('discovery_err_source_missing');
      case 'DISCOVERY_CANDIDATE_NOT_FOUND':
        return t('discovery_err_candidate_missing');
      default:
        return err.message || t('discovery_err_mutation');
    }
  }
  return err instanceof Error && err.message ? err.message : t('discovery_err_mutation');
}

/** Registry status is displayed verbatim; it is never folded into health. */
export function observationLabel(state: string, t: Translate): string {
  switch (state) {
    case 'seen':
      return t('discovery_state_seen');
    case 'missing':
      return t('discovery_state_missing');
    case 'stale':
      return t('discovery_state_stale');
    default:
      return state;
  }
}

export function observationStateBadgeClass(
  state: DiscoveryObservationState | string,
  styles: Record<string, string>,
): string {
  if (state === 'seen') return styles.badgeOk;
  if (state === 'missing') return styles.badgeDanger;
  return styles.badgeWarn;
}

/**
 * The third funnel column. An unlinked candidate reports n/a (the link column
 * already states that fact); a failed association lookup is unresolved and
 * must never render as unmonitored.
 */
export function monitoringBadgeClass(
  candidate: NfObservation,
  styles: Record<string, string>,
): string {
  const assoc = candidate.monitoringAssociation;
  if (!candidate.linkedResourceId) return styles.badgeMuted;
  if (!assoc) return styles.badgeWarn;
  switch (assoc.state as CandidateMonitoringState) {
    case 'monitored':
      return styles.badgeOk;
    case 'unresolved':
      return styles.badgeWarn;
    default:
      return styles.badgeMuted;
  }
}

export function monitoringLabel(candidate: NfObservation, t: Translate): string {
  const assoc = candidate.monitoringAssociation;
  if (!candidate.linkedResourceId) return t('discovery_monitoring_na');
  if (!assoc) return t('discovery_monitoring_unresolved');
  switch (assoc.state as CandidateMonitoringState) {
    case 'monitored':
      return t('discovery_monitored');
    case 'unresolved':
      return t('discovery_monitoring_unresolved');
    default:
      return t('discovery_unmonitored');
  }
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

export function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
