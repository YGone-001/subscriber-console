import type { UEInfo, UEInfoResponse, UEQuery } from './types';

export type UEDomainFilter = '' | 'EPS' | '5GS';
export type UEMMFilter = '' | 'registered' | 'unregistered' | 'unknown';
export type UECMFilter = '' | 'idle' | 'connected' | 'unknown';

const UE_DOMAINS: UEDomainFilter[] = ['EPS', '5GS'];
const UE_MM_STATES: UEMMFilter[] = ['registered', 'unregistered', 'unknown'];
const UE_CM_STATES: UECMFilter[] = ['idle', 'connected', 'unknown'];

/** Reads a URL domain token; unknown values degrade to "all". */
export function readUEDomainFilter(value: string | undefined): UEDomainFilter {
  return UE_DOMAINS.includes(value as UEDomainFilter) ? (value as UEDomainFilter) : '';
}

/** Reads a registration-management filter; unknown values degrade to "all". */
export function readUEMMFilter(value: string | undefined): UEMMFilter {
  return UE_MM_STATES.includes(value as UEMMFilter) ? (value as UEMMFilter) : '';
}

/** Reads a connection-management filter; unknown values degrade to "all". */
export function readUECMFilter(value: string | undefined): UECMFilter {
  return UE_CM_STATES.includes(value as UECMFilter) ? (value as UECMFilter) : '';
}

export function buildUEInfoPath(query: UEQuery = {}): string {
  const params = new URLSearchParams();
  if (query.summary) params.set('summary', '1');
  if (query.q) params.set('q', query.q);
  if (query.domain) params.set('domain', query.domain);
  if (query.mmState) params.set('mmState', query.mmState);
  if (query.cmState) params.set('cmState', query.cmState);
  if (typeof query.limit === 'number') params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const suffix = params.toString();
  return suffix ? `/api/ue-info?${suffix}` : '/api/ue-info';
}

export function formatBandwidth(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  if (bps >= 1_000_000_000) return `${(bps / 1_000_000_000).toFixed(1)} Gbps`;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} Kbps`;
  return `${bps} bps`;
}

export function formatUETimestamp(timestamp: number | null | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—';
  const milliseconds = timestamp > 1_000_000_000_000_000
    ? timestamp / 1_000
    : timestamp > 1_000_000_000_000
      ? timestamp
      : timestamp > 1_000_000_000
        ? timestamp * 1_000
        : 0;
  if (!milliseconds) return '—';
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/**
 * Registration-management token for tone only. It never collapses the CM
 * dimension: a registered UE can be idle or connected at the same time.
 */
export function ueMMToken(ue: UEInfo): 'registered' | 'unregistered' | 'unknown' {
  const state = ue.mmState.trim().toLowerCase();
  if (state === 'registered') return 'registered';
  if (!state) return 'unknown';
  return 'unregistered';
}

/** Connection-management token, independent of the registration dimension. */
export function ueCMToken(ue: UEInfo): 'idle' | 'connected' | 'unknown' {
  const state = ue.cmState.trim().toLowerCase();
  if (state === 'idle') return 'idle';
  if (state === 'connected') return 'connected';
  return 'unknown';
}

/** Localizes the known MM/RM values and preserves an unexpected upstream value. */
export function ueMMStateLabel(state: string, t: (key: string) => string): string {
  const value = state.trim();
  if (!value) return t('ue_state_unreported');
  const lower = value.toLowerCase();
  if (lower === 'registered') return t('ue_state_registered');
  if (lower === 'unregistered' || lower === 'deregistered' || lower === 'not_registered') {
    return t('ue_state_unregistered');
  }
  return value;
}

/** Localizes the known CM/ECM values and preserves an unexpected upstream value. */
export function ueCMStateLabel(state: string, t: (key: string) => string): string {
  const value = state.trim();
  if (!value) return t('ue_state_unreported');
  const lower = value.toLowerCase();
  if (lower === 'idle') return t('ue_state_idle');
  if (lower === 'connected') return t('ue_state_connected');
  return value;
}

export function sourceLabelKey(id: string): string {
  switch (id) {
    case 'mme':
    case 'amf':
    case 'smf':
    case 'smf_metrics':
    case 'subscribers':
    case 'ims':
    case 'config':
      return `ue_source_${id}`;
    default:
      return 'ue_source_unknown';
  }
}

export function hasUnavailableSource(response: UEInfoResponse | undefined): boolean {
  return Boolean(response?.sources.some((source) => source.state === 'unavailable' || source.state === 'invalid_config'));
}

export function ueCountLabel(value: number | null, unreportedLabel: string): string {
  return value === null ? unreportedLabel : String(value);
}
