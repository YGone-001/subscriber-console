import type {
  CollectionMode,
  CreateNfHealthTargetRequest,
  LayerState,
  ServiceKind,
  UpdateNfHealthTargetRequest,
} from './nf-health-types';

export type NfHealthTargetForm = {
  candidateId: string;
  name: string;
  collectorProfile: string;
  metricsDestination: string;
  metricsPath: string;
  serviceUnit: string;
  serviceKind: ServiceKind;
  collectionMode: CollectionMode;
  intervalSeconds: number;
  enabled: boolean;
};

export function createEmptyTargetForm(defaultIntervalSeconds: number): NfHealthTargetForm {
  return {
    candidateId: '',
    name: '',
    collectorProfile: 'http_metrics',
    metricsDestination: '',
    metricsPath: '/metrics',
    serviceUnit: '',
    serviceKind: 'process',
    collectionMode: 'manual',
    intervalSeconds: defaultIntervalSeconds,
    enabled: true,
  };
}

export function buildMetricsEndpoint(destination: string, path: string): string | undefined {
  const trimmedDestination = destination.trim();
  if (!trimmedDestination) return undefined;
  const trimmedPath = path.trim() || '/metrics';
  const normalizedPath = trimmedPath.startsWith('/') ? trimmedPath : `/${trimmedPath}`;
  return `http://${trimmedDestination}${normalizedPath}`;
}

export function splitMetricsEndpoint(endpoint?: string): { destination: string; path: string } {
  if (!endpoint) return { destination: '', path: '/metrics' };
  try {
    const parsed = new URL(endpoint);
    const destination = parsed.host;
    const path = parsed.pathname || '/metrics';
    return { destination, path };
  } catch {
    return { destination: '', path: '/metrics' };
  }
}

export function buildCreateTargetRequest(form: NfHealthTargetForm): CreateNfHealthTargetRequest {
  const metricsEndpoint = buildMetricsEndpoint(form.metricsDestination, form.metricsPath);
  return {
    candidateId: form.candidateId.trim(),
    name: form.name.trim(),
    collectorProfile: form.collectorProfile,
    metricsEndpoint,
    serviceUnit: form.serviceUnit.trim() || undefined,
    serviceKind: form.serviceKind,
    collectionMode: form.collectionMode,
    intervalSeconds: form.intervalSeconds,
    enabled: form.enabled,
  };
}

export function buildUpdateTargetRequest(
  expectedRevision: number,
  form: NfHealthTargetForm,
): UpdateNfHealthTargetRequest {
  const metricsEndpoint = buildMetricsEndpoint(form.metricsDestination, form.metricsPath);
  return {
    expectedRevision,
    target: {
      name: form.name.trim(),
      metricsEndpoint,
      serviceUnit: form.serviceUnit.trim() || undefined,
      serviceKind: form.serviceKind,
      collectionMode: form.collectionMode,
      intervalSeconds: form.intervalSeconds,
      enabled: form.enabled,
    },
  };
}

export function windowStartIso(windowKey: TrendWindowKey, now = new Date()): string {
  const minutes = TREND_WINDOW_MINUTES[windowKey];
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export type TrendWindowKey = '15m' | '1h' | '6h' | '24h';

export const TREND_WINDOWS: TrendWindowKey[] = ['15m', '1h', '6h', '24h'];

export const TREND_WINDOW_MINUTES: Record<TrendWindowKey, number> = {
  '15m': 15,
  '1h': 60,
  '6h': 360,
  '24h': 1440,
};

export function layerStateTone(state: LayerState): 'healthy' | 'degraded' | 'unhealthy' | 'muted' | 'unknown' {
  switch (state) {
    case 'healthy':
      return 'healthy';
    case 'degraded':
    case 'stale':
      return 'degraded';
    case 'unhealthy':
      return 'unhealthy';
    case 'not_configured':
      return 'muted';
    default:
      return 'unknown';
  }
}
