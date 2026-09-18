import { fetcher } from "@/lib/fetcher";

export interface TariffPlan {
  plan_id: string;
  name: string;
  description: string;
  status: string;
  version?: number;
  rulesCount: number;
  subscriberCount: number;
  isDefault: boolean;
  quota_per_grant?: number;
  validity_time?: number;
  volume_threshold?: number;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TariffListResponse {
  plans: TariffPlan[];
  total: number;
}

export interface TariffActionResponse {
  outcome?: string;
  message?: string;
  approval?: Record<string, unknown>;
  error?: string;
}

const BASE = "/api/tariff-plans";

export const ocsTariffApi = {
  list: () => fetcher(BASE),
  get: (planId: string) => fetcher(`${BASE}/${planId}`),
  getRules: (planId: string) => fetcher(`${BASE}/${planId}/rules`),
  getOperations: (planId: string) => fetcher(`${BASE}/${planId}/operations`),
  getSubscribers: (planId: string) => fetcher(`${BASE}/${planId}/subscribers`),

  clone: async (planId: string, targetPlanId: string): Promise<TariffActionResponse> => {
    const res = await fetch(`${BASE}/${planId}/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_plan_id: targetPlanId }),
    });
    return res.json();
  },

  enable: async (planId: string): Promise<TariffActionResponse> => {
    const res = await fetch(`${BASE}/${planId}/enable`, { method: "POST" });
    return res.json();
  },

  disable: async (planId: string): Promise<TariffActionResponse> => {
    const res = await fetch(`${BASE}/${planId}/disable`, { method: "POST" });
    return res.json();
  },

  remove: async (planId: string): Promise<TariffActionResponse> => {
    const res = await fetch(`${BASE}/${planId}`, { method: "DELETE" });
    return res.json();
  },
};
