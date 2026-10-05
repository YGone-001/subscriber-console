/**
 * Dashboard view-model.
 *
 * Pure mapping from the current accepted read contracts to presentation data.
 * Nothing here fabricates a value: a metric the contract does not report becomes
 * an explicit unavailable state.
 */

export type UnknownRecord = Record<string, unknown>;

export type ChartPoint = { name: string; value: number };
export type SeriesPoint = { index: number; value: number };
export type KpiTone = 'neutral' | 'success' | 'warning' | 'danger';

export type KpiModel = {
  id: string;
  labelKey: string;
  value: string;
  unit?: string;
  tone: KpiTone;
  hintKey?: string;
};

export type WorkbenchItem = {
  id: string;
  level: string;
  reason: string;
  imsi: string;
  timestamp: string;
};

export type DashboardModel = {
  available: boolean;
  refreshedAt: number;
  kpis: KpiModel[];
  trafficSeries: SeriesPoint[];
  subscriberSeries: SeriesPoint[];
  plmnPoints: ChartPoint[];
  tariffPoints: ChartPoint[];
  topConsumers: ChartPoint[];
  workbench: WorkbenchItem[];
  balances: UnknownRecord | null;
  sessions: UnknownRecord | null;
  reservations: UnknownRecord | null;
  usage: UnknownRecord | null;
};

export const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : {};

export const listOf = (value: unknown): UnknownRecord[] => (Array.isArray(value) ? value.map(asRecord) : []);

export const numberValue = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0) || 0;

export const text = (value: unknown): string =>
  value === undefined || value === null || value === '' ? '-' : String(value);

/** Compact binary byte formatting. Returns 0 B for absent or zero input. */
export function formatBytes(value: number): { value: string; unit: string } {
  if (!Number.isFinite(value) || value === 0) return { value: '0', unit: 'B' };
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** exponent;
  return {
    value: scaled >= 100 || exponent === 0 ? scaled.toFixed(0) : scaled.toFixed(1),
    unit: units[exponent],
  };
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '-';
}

export function seriesOf(value: unknown): SeriesPoint[] {
  return (Array.isArray(value) ? value : []).map((point, index) => ({ index, value: numberValue(point) }));
}

export function toChartPoints(value: unknown, limit = 8): ChartPoint[] {
  return listOf(value)
    .map((row) => ({
      name: text(row.name ?? row.planId ?? row.imsi ?? row.apn),
      value: numberValue(row.value ?? row.count ?? row.subscriberCount ?? row.balance),
    }))
    .filter((point) => point.name !== '-')
    .slice(0, limit);
}

export function hasMetrics(metrics: unknown): boolean {
  return Object.keys(asRecord(metrics)).length > 0;
}

export function buildKpis(input: {
  totalTraffic: number;
  subscribers: number;
  activeAlerts: number;
  criticalAlerts: number;
  contracts: number | undefined;
  activeSessions: number;
  totalSessions: number;
  utilization: number;
  allInvariantsOk: boolean;
  brokenInvariants: number;
  gyCount: number;
  roCount: number;
}): KpiModel[] {
  const traffic = formatBytes(input.totalTraffic);
  return [
    { id: 'traffic', labelKey: 'dashboard_kpi_traffic', value: traffic.value, unit: traffic.unit, tone: 'neutral' },
    { id: 'subscribers', labelKey: 'dashboard_kpi_subscribers', value: formatNumber(input.subscribers), tone: 'neutral' },
    {
      id: 'alerts',
      labelKey: 'dashboard_kpi_alerts',
      value: formatNumber(input.activeAlerts),
      tone: input.criticalAlerts > 0 ? 'danger' : input.activeAlerts > 0 ? 'warning' : 'success',
      hintKey: input.criticalAlerts > 0 ? 'noc_critical' : undefined,
    },
    {
      id: 'contracts',
      labelKey: 'dashboard_kpi_contracts',
      value: input.contracts === undefined ? '-' : formatNumber(input.contracts),
      tone: 'neutral',
    },
    {
      id: 'active-sessions',
      labelKey: 'dashboard_kpi_active_sessions',
      value: formatNumber(input.activeSessions),
      tone: 'neutral',
      hintKey: 'dashboard_sessions_total',
    },
    {
      id: 'utilization',
      labelKey: 'dashboard_kpi_utilization',
      value: input.utilization > 0 ? input.utilization.toFixed(1) : '0',
      unit: '%',
      tone: 'neutral',
    },
    {
      id: 'invariants',
      labelKey: 'dashboard_kpi_invariants',
      value: input.allInvariantsOk
        ? 'dashboard_invariants_ok'
        : `dashboard_invariants_broken:${input.brokenInvariants}`,
      tone: input.allInvariantsOk ? 'success' : 'danger',
    },
    {
      id: 'gy-ro',
      labelKey: 'dashboard_gy_ro',
      value: `${formatNumber(input.gyCount)} / ${formatNumber(input.roCount)}`,
      tone: 'neutral',
    },
  ];
}

export function buildWorkbench(alertRows: UnknownRecord[], limit = 5): WorkbenchItem[] {
  return alertRows
    .filter((row) => !row.is_acknowledged)
    .slice(0, limit)
    .map((row, index) => ({
      id: text(row.id ?? `${row.timestamp ?? 'alert'}:${index}`),
      level: text(row.level),
      reason: text(row.reason),
      imsi: text(row.imsi),
      timestamp: text(row.timestamp),
    }));
}

export function buildDashboardModel(input: {
  metrics: unknown;
  sparkline: unknown;
  alerts: unknown;
  contracts: unknown;
}): DashboardModel {
  const metric = asRecord(input.metrics);
  const balances = asRecord(metric.ocsBalances);
  const sessions = asRecord(metric.ocsSessions);
  const reservations = asRecord(metric.ocsReservations);
  const usage = asRecord(metric.ocsUsage);
  const spark = asRecord(input.sparkline);
  const alertsRecord = asRecord(input.alerts);
  const alertRows = listOf(alertsRecord.alerts);
  const activeAlerts = numberValue(alertsRecord.activeCount ?? alertRows.length);
  const criticalAlerts = numberValue(alertsRecord.activeCriticalCount);
  const contractsTotal = asRecord(input.contracts).total ?? asRecord(asRecord(input.contracts).pagination).total;
  const utilization = numberValue(balances.dataUtilizationRate);
  const allInvariantsOk = balances.allInvariantsOk === true;

  const available = hasMetrics(input.metrics);

  return {
    available,
    refreshedAt: numberValue(metric.timestamp),
    kpis: buildKpis({
      totalTraffic: numberValue(metric.totalTraffic),
      subscribers: numberValue(balances.totalSubscribers ?? spark.currentSubCount),
      activeAlerts,
      criticalAlerts,
      contracts: contractsTotal === undefined ? undefined : numberValue(contractsTotal),
      activeSessions: numberValue(sessions.activeSessions),
      totalSessions: numberValue(sessions.totalSessions),
      utilization,
      allInvariantsOk,
      brokenInvariants: numberValue(balances.brokenInvariantCount),
      gyCount: numberValue(sessions.interfaceGyCount),
      roCount: numberValue(sessions.interfaceRoCount),
    }),
    trafficSeries: seriesOf(spark.traffic),
    subscriberSeries: seriesOf(spark.subscribers),
    plmnPoints: toChartPoints(metric.plmnDist),
    tariffPoints: toChartPoints(metric.tariffPlanDist),
    topConsumers: toChartPoints(metric.top5),
    workbench: buildWorkbench(alertRows),
    balances: available ? balances : null,
    sessions: available ? sessions : null,
    reservations: available ? reservations : null,
    usage: available ? usage : null,
  };
}
