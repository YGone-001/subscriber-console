import type {
  CollectionMode,
  CollectorProfile,
  CreateNfHealthTargetRequest,
  HealthSample,
  InterfaceProbe,
  LayerState,
  ProbeFamily,
  ServiceKind,
  UpdateNfHealthTargetRequest,
} from './nf-health-types';

/* One editable extra probe row. Destination and path are kept apart so the
 * dialog can reuse the same allowlisted destination picker as the metrics
 * endpoint; the request is built from both. */
export type TargetProbeForm = {
  family: ProbeFamily;
  destination: string;
  path: string;
};

export type NfHealthTargetForm = {
  resourceId: string;
  candidateId: string;
  name: string;
  collectorProfile: CollectorProfile;
  metricsDestination: string;
  metricsPath: string;
  probes: TargetProbeForm[];
  serviceUnit: string;
  serviceKind: ServiceKind;
  collectionMode: CollectionMode;
  intervalSeconds: number;
  enabled: boolean;
};

export function createEmptyTargetForm(defaultIntervalSeconds: number): NfHealthTargetForm {
  return {
    resourceId: '',
    candidateId: '',
    name: '',
    collectorProfile: 'http_metrics',
    metricsDestination: '',
    metricsPath: '/metrics',
    probes: [],
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

/** Converts declared probes into editable rows. */
export function probeFormRows(probes?: InterfaceProbe[]): TargetProbeForm[] {
  return (probes ?? []).map((probe) => ({
    family: probe.family,
    ...splitMetricsEndpoint(probe.url),
  }));
}

/** Builds the request probes, dropping rows without a destination. */
export function buildProbes(rows: TargetProbeForm[]): InterfaceProbe[] {
  const probes: InterfaceProbe[] = [];
  for (const row of rows) {
    const url = buildMetricsEndpoint(row.destination, row.path);
    if (!url) continue;
    probes.push({ family: row.family, url });
  }
  return probes;
}

export function buildCreateTargetRequest(form: NfHealthTargetForm): CreateNfHealthTargetRequest {
  const processOnly = form.collectorProfile === 'process_only';
  const metricsEndpoint = processOnly ? undefined : buildMetricsEndpoint(form.metricsDestination, form.metricsPath);
  return {
    resourceId: form.resourceId.trim() || undefined,
    candidateId: form.candidateId.trim() || undefined,
    name: form.name.trim(),
    collectorProfile: form.collectorProfile,
    metricsEndpoint,
    probes: processOnly ? undefined : buildProbes(form.probes),
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
      probes: buildProbes(form.probes),
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

export type TrendPoint = {
  t: number;
  label: string;
  value: number | null;
};

export type MetricTrendSeries = {
  key: string;
  unit: string;
  points: TrendPoint[];
};

/*
 * Build per-metric trend series from collected samples. Points are plotted
 * only where a measurement exists and gaps are never interpolated; samples
 * older than the window start are excluded before bucketing.
 */
export function buildMetricTrendSeries(
  samples: HealthSample[],
  fromMs: number,
): MetricTrendSeries[] {
  const buckets = new Map<string, TrendPoint[]>();
  const units = new Map<string, string>();
  const ordered = [...samples].sort(
    (left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt),
  );
  for (const sample of ordered) {
    const collectedAt = Date.parse(sample.collectedAt);
    if (!Number.isFinite(collectedAt) || collectedAt < fromMs) continue;
    for (const metric of sample.metrics ?? []) {
      const points = buckets.get(metric.key) ?? [];
      points.push({
        t: collectedAt,
        label: new Date(collectedAt).toLocaleTimeString(),
        value: metric.value,
      });
      buckets.set(metric.key, points);
      units.set(metric.key, metric.unit);
    }
  }
  return Array.from(buckets.entries()).map(([key, points]) => ({
    key,
    unit: units.get(key) ?? '',
    points,
  }));
}

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
