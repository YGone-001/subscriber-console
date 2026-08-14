export const CURRENCIES = ["USD", "EUR", "GBP", "CNY", "HKD", "JPY", "KRW", "SGD", "AUD", "CAD"];
export const DEFAULT_OCS_PLAN_ID = "plan_default_10gb";
export const DATA_GRANT = "10485760";
export const DATA_THRESHOLD = "8388608";
export const VOICE_GRANT = "60";
export const SMS_GRANT = "1";

export type ChargingType = "data_volume" | "voice_time" | "free" | "sms_event" | "event";
export type ServiceKey = "all" | "data" | "voice" | "sms" | "ims";

export type RatingPolicy = {
  rating_group_id: number;
  currency: string;
  rates: string;
  rates_type: number;
  rule_id?: string;
  apn?: string;
  service_identifier?: number;
  charging_type?: ChargingType | string;
  unit?: string;
  quota_per_grant?: number;
  validity_time?: number;
  volume_threshold?: number;
  priority?: number;
  status?: string;
};

export type TariffPlan = {
  plan_id: string;
  name: string;
  description?: string;
  status: string;
  rulesCount: number;
  subscriberCount: number;
  isDefault?: boolean;
  quota_per_grant?: number;
  validity_time?: number;
  volume_threshold?: number;
  rules?: RatingPolicy[];
};

export type PlanSubscriberPreview = {
  total: number;
  subscribers: Array<{ imsi: string; msisdn?: string; status?: string }>;
  hasMore: boolean;
  activeCount?: number;
  suspendedCount?: number;
};

export type PlanOperationLog = {
  id: string;
  timestamp: string;
  level: "info" | "warning";
  action: string;
  targetId: string;
  operatorIp: string;
};

export type PlanOperationsData = {
  summary: {
    totalPlans: number;
    activePlans: number;
    disabledPlans: number;
    totalLinkedSubscribers: number;
    selectedLinkedSubscribers: number;
    selectedSharePct: number;
    recentActivityCount: number;
    lastChangedAt?: string | null;
  };
  history: PlanOperationLog[];
};

export type PlanForm = {
  plan_id: string;
  name: string;
  description: string;
  status: string;
  quota_per_grant?: string | number;
  validity_time?: string | number;
  volume_threshold?: string | number;
};

export type RatingForm = {
  rating_group_id: string;
  currency: string;
  rates: string;
  rates_type: number;
  charging_type: ChargingType;
  apn: string;
  service_identifier: string;
  quota_per_grant: string;
  validity_time: string;
  volume_threshold: string;
};

export type Notice = {
  type: "error" | "success";
  text: string;
};

export type RatingManagementView = "plans" | "rules";

export const SERVICE_FILTERS: ServiceKey[] = ["all", "data", "voice", "sms", "ims"];

export function defaultsFor(type: ChargingType): Omit<RatingForm, "rating_group_id" | "currency" | "rates"> {
  if (type === "voice_time") {
    return {
      rates_type: 1,
      charging_type: "voice_time",
      apn: "ims",
      service_identifier: "1",
      quota_per_grant: VOICE_GRANT,
      validity_time: "300",
      volume_threshold: "0",
    };
  }
  if (type === "free") {
    return {
      rates_type: 4,
      charging_type: "free",
      apn: "ims",
      service_identifier: "0",
      quota_per_grant: "0",
      validity_time: "0",
      volume_threshold: "0",
    };
  }
  if (type === "sms_event" || type === "event") {
    return {
      rates_type: 3,
      charging_type: "sms_event",
      apn: "ims",
      service_identifier: "1",
      quota_per_grant: SMS_GRANT,
      validity_time: "0",
      volume_threshold: "0",
    };
  }
  return {
    rates_type: 2,
    charging_type: type,
    apn: "internet",
    service_identifier: "1",
    quota_per_grant: DATA_GRANT,
    validity_time: "300",
    volume_threshold: DATA_THRESHOLD,
  };
}

export function makeDefaultForm(type: ChargingType = "data_volume"): RatingForm {
  return {
    rating_group_id: "",
    currency: "USD",
    rates: "0",
    ...defaultsFor(type),
  };
}

export function classifyPolicy(rating: RatingPolicy): Exclude<ServiceKey, "all"> {
  if (rating.charging_type === "voice_time") return "voice";
  if (rating.charging_type === "sms_event" || rating.unit === "events") return "sms";
  if ((rating.apn || "").toLowerCase() === "ims") return "ims";
  return "data";
}

export function formatGrant(t: (key: string) => string, value: unknown, unit?: string, chargingType?: string) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0 || chargingType === "free") return t("rating_grant_included");
  if (chargingType === "voice_time" || unit === "seconds") {
    if (amount >= 3600) return `${Math.round(amount / 3600)} h`;
    if (amount >= 60) return `${Math.round(amount / 60)} min`;
    return `${amount} s`;
  }
  if (chargingType === "sms_event" || unit === "events") return `${amount} SMS`;
  if (amount >= 1024 ** 3) return `${(amount / 1024 ** 3).toFixed(1)} GB`;
  if (amount >= 1024 ** 2) return `${Math.round(amount / 1024 ** 2)} MB`;
  if (amount >= 1024) return `${Math.round(amount / 1024)} KB`;
  return `${amount} B`;
}

export function applyChargingType(form: RatingForm, chargingType: ChargingType): RatingForm {
  return {
    ...form,
    ...defaultsFor(chargingType),
  };
}
