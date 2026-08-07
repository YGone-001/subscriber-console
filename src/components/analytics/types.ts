import React from "react";

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

export type MetricsData = {
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
};

export type SparklineData = {
  subscribers?: number[];
  traffic?: number[];
  currentSubCount?: number;
  currentTraffic?: number;
};

export type AlertItem = {
  id: string;
  timestamp: string;
  level: "CRITICAL" | "WARNING" | string;
  imsi?: string;
  reason: string;
  is_acknowledged?: boolean;
};

export type AlertResponse = {
  alerts?: AlertItem[];
  activeCriticalCount?: number;
  activeWarningCount?: number;
  activeCount?: number;
};

export type KpiCardProps = {
  color: string;
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
  sparkline?: number[];
  ringValue?: number;
  tone?: "normal" | "warning" | "danger";
  badge?: React.ReactNode;
  tag?: React.ReactNode;
  onClick?: () => void;
};

export type WorkItem = {
  id: string;
  tone: "danger" | "warning" | "normal";
  priority?: "P0" | "P1" | "P2";
  title: string;
  detail: string;
  href: string;
  action: string;
};

export type ChangeTask = {
  id: string;
  tone: "danger" | "warning" | "normal";
  title: string;
  scope: string;
  phase: string;
  canary: number;
  owner: string;
  href: string;
  rollbackHref: string;
};
