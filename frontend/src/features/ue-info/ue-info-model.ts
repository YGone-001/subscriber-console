import type { UEInfo, UEInfoResponse, UEQuery } from './types';

export function buildUEInfoPath(query: UEQuery = {}): string {
  const params = new URLSearchParams();
  if (query.summary) params.set('summary', '1');
  if (query.q) params.set('q', query.q);
  if (query.domain) params.set('domain', query.domain);
  if (query.state) params.set('state', query.state);
  if (typeof query.limit === 'number') params.set('limit', String(query.limit));
  if (typeof query.offset === 'number') params.set('offset', String(query.offset));
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
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function ueStateToken(ue: UEInfo): 'registered' | 'idle' | 'connected' | 'unknown' {
  if (ue.mmState.toLowerCase() === 'registered') return 'registered';
  if (ue.cmState.toLowerCase() === 'idle') return 'idle';
  if (ue.cmState.toLowerCase() === 'connected') return 'connected';
  return 'unknown';
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
