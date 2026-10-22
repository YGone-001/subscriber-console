/*
 * Forward-ported from the historical xCloud UI (reference commit 2c40903):
 * frontend/src/app/(dashboard)/subscribers/types.ts
 * Adaptations: `@/` aliases repointed; the feedback tone re-exported from the current primitives.
 */
import { type FeedbackTone } from '../../components/ui/OperationFeedback';
export type { FeedbackTone };

export interface PlmnRecord {
  mcc: string;
  mnc: string;
  network?: string;
  country?: string;
  country_code?: string;
}

export type SubscriberProvisioning = {
  contract: boolean;
  balance: boolean;
  tariffPlan: boolean;
};

export type SubscriberTrafficSnapshot = {
  used: number;
  total: number;
  balance?: number;
};

export type SubscriberSmsSnapshot = {
  used: number;
  total: number;
  balance?: number;
};

export type SubscriberBalanceState = "missing" | "exhausted" | "low" | "normal";

export interface SubscriberRow {
  imsi: string;
  msisdn?: string;
  status: string;
  contractStatus?: string;
  balanceState?: SubscriberBalanceState;
  balanceThreshold?: number;
  policy?: string;
  policyName?: string;
  policyStatus?: string;
  provisioning?: SubscriberProvisioning;
  lastActive: string;
  ard?: number;
  plmn?: string;
  profile?: string;
  traffic?: SubscriberTrafficSnapshot;
  sms?: SubscriberSmsSnapshot;
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
};

export type FeedbackState = {
  tone: FeedbackTone;
  title?: string;
  message: string;
};

export type PendingDelete = {
  mode: "single" | "bulk";
  imsis: string[];
};

export type SubscriberAccessStatus = "all" | "active" | "restricted";
export type SubscriberContractStatus = "all" | "active" | "suspended" | "terminated" | "none";
export type SubscriberProvisioningStatus =
  | "all"
  | "complete"
  | "incomplete"
  | "missing_contract"
  | "missing_balance"
  | "missing_plan";
export type SubscriberBalanceStatus = "all" | "exhausted" | "low" | "normal" | "available" | "missing";

export type SubscriberFilters = {
  access: SubscriberAccessStatus;
  contract: SubscriberContractStatus;
  provisioning: SubscriberProvisioningStatus;
  planId: string;
  balance: SubscriberBalanceStatus;
};

export type SubscriberSummaryKey = "all" | "active" | "restricted" | "lowBalance" | "unprovisioned";

export type SubscriberSummary = {
  total: number;
  active: number;
  restricted: number;
  lowTraffic: number;
  lowBalance: number;
  unprovisioned: number;
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
  matchedBy?: "imsi" | "msisdn";
  matchSource?: string;
}

export type SubscriberListResponse = SubscribersResponse;

export type StatusLabelMap = Record<string, string>;
