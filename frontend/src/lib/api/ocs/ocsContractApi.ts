import { fetcher } from "@/lib/fetcher";

export interface OcsContract {
  id: string;
  imsi: string;
  msisdn: string;
  status: string;
  plan_id: string;
  created_at?: string;
  updated_at?: string;
}

export interface ContractListResponse {
  records: OcsContract[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
}

export interface ContractActionResponse {
  outcome?: string;
  message?: string;
  approval?: Record<string, unknown>;
  error?: string;
}

const BASE = "/api/ocs/subscribers";

export const ocsContractApi = {
  list: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== "" && v !== undefined && v !== null) qs.set(k, String(v));
    }
    return fetcher(`${BASE}?${qs.toString()}`);
  },

  suspend: async (imsi: string): Promise<ContractActionResponse> => {
    const res = await fetch(`${BASE}/${imsi}/suspend`, { method: "POST" });
    return res.json();
  },

  resume: async (imsi: string): Promise<ContractActionResponse> => {
    const res = await fetch(`${BASE}/${imsi}/resume`, { method: "POST" });
    return res.json();
  },

  terminate: async (imsi: string): Promise<ContractActionResponse> => {
    const res = await fetch(`${BASE}/${imsi}`, { method: "DELETE" });
    return res.json();
  },

  changeTariff: async (imsi: string, planId: string): Promise<ContractActionResponse> => {
    const res = await fetch(`${BASE}/${imsi}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_id: planId }),
    });
    return res.json();
  },
};
