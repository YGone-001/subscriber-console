/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/components/analytics/types.ts
 * Adaptations: "use client" and the local analytics.css import dropped (the layer
 * is imported from app.css); Next.js Link replaced by react-router Link; @/ path
 * aliases rewritten to relative paths.
 */
export type DistributionPoint = {
  name: string;
  value: number;
};

export type TopConsumer = {
  imsi: string;
  balance: number;
  voiceBalance: number;
  smsBalance: number;
};

export type OcsBalanceMetrics = {
  totalSubscribers: number;
  totalDataAllocated: number;
  totalDataUsed: number;
  totalDataReserved: number;
  totalDataAvailable: number;
  dataUtilizationRate: number;
  totalVoiceAllocated: number;
  totalVoiceUsed: number;
  totalVoiceReserved: number;
  totalVoiceAvailable: number;
  totalSmsAllocated: number;
  totalSmsUsed: number;
  totalSmsAvailable: number;
  validInvariantCount: number;
  brokenInvariantCount: number;
  allInvariantsOk: boolean;
  invariantChecked: number;
  invariantSampleLimit: number;
  invariantScope: string;
  voiceAllocationDefaulted: number;
  smsAllocationDefaulted: number;
};

export type OcsSessionMetrics = {
  totalSessions: number;
  activeSessions: number;
  closingSessions: number;
  closedSessions: number;
  totalGrantedOctets: number;
  totalUsedOctets: number;
  interfaceGyCount: number;
  interfaceRoCount: number;
  apnDistribution: Array<{ apn: string; count: number }>;
  activeUsedOctets: number;
  activeUsageTop: TopUsageEntry[];
};

export type OcsReservationMetrics = {
  totalReservations: number;
  activeReservations: number;
  settledReservations: number;
  releasedReservations: number;
  orphanedReservations: number;
  totalReservedOctets: number;
  totalReleasedOctets: number;
  totalUsedOctets: number;
};

export type TariffPlanDistItem = {
  planId: string;
  name: string;
  subscriberCount: number;
  percentage: number;
  status: string;
};

export type OcsUsageMetrics = {
  totalRecords: number;
  chargedRecords: number;
  totalInputOctets: number;
  totalOutputOctets: number;
  totalOctets: number;
};

export type UsageTrendPoint = {
  hour: string;
  octets: number;
};

export type TopUsageEntry = {
  imsi: string;
  usedOctets: number;
  share: number;
};

export type MetricsData = {
  /** Legacy: remaining data available, not consumed traffic. */
  totalTraffic: number;
  plmnDist?: DistributionPoint[];
  ratesDist?: DistributionPoint[];
  top5?: TopConsumer[];
  timestamp?: number;
  error?: string;
  ocsBalances?: OcsBalanceMetrics;
  ocsSessions?: OcsSessionMetrics;
  ocsReservations?: OcsReservationMetrics;
  tariffPlanDist?: TariffPlanDistItem[];
  ocsUsage?: OcsUsageMetrics;
  usageWindowHours?: number;
  usageWindowRecords?: number;
  usageWindowTotalOctets?: number;
  usageTrend?: UsageTrendPoint[];
  topUsage?: TopUsageEntry[];
  latestUsageAt?: string;
};

export type BusinessRisk = {
  id: string;
  tone: 'danger' | 'warning' | 'info';
  title: string;
  detail: string;
  href: string;
  action: string;
};
