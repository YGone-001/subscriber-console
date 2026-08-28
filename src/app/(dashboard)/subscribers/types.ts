export interface PlmnRecord {
  mcc: string;
  mnc: string;
  network?: string;
  country?: string;
  country_code?: string;
}

export interface SubscriberRow {
  imsi: string;
  status: string;
  policy?: string;
  policyName?: string;
  policyStatus?: string;
  lastActive: string;
  ard?: number;
  traffic?: {
    used: number;
    total: number;
    balance?: number;
  };
  [key: string]: unknown;
}

export type TrafficAdjustmentMode = "credit" | "debit";

export type TrafficAdjustmentTarget = {
  imsi: string;
  traffic: {
    used: number;
    total: number;
    balance: number;
  };
  mode: TrafficAdjustmentMode;
};

import { type FeedbackTone } from "@/components/OperationFeedback";
export type { FeedbackTone };

export type FeedbackState = {
  tone: FeedbackTone;
  title?: string;
  message: string;
};

export type PendingDelete = {
  mode: "single" | "bulk";
  imsis: string[];
};

export type SubscriberStatusFilter = "all" | "active" | "restricted" | "lowTraffic";

export type SubscriberSummary = {
  total: number;
  active: number;
  restricted: number;
  lowTraffic: number;
};

export interface ProfilesResponse {
  profiles: Array<{ name: string; title?: string }>;
}

export interface SubscribersResponse {
  subscribers: SubscriberRow[];
  total: number;
  page: number;
  limit: number;
  summary?: SubscriberSummary;
}
