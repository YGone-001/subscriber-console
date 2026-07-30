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

export type MetricsData = {
  totalTraffic: number;
  plmnDist?: DistributionPoint[];
  ratesDist?: DistributionPoint[];
  top5?: TopConsumer[];
  timestamp?: number;
  error?: string;
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
};

export type WorkItem = {
  id: string;
  tone: "danger" | "warning" | "normal";
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
