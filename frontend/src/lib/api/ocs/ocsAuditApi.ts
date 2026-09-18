import { fetcher } from "@/lib/fetcher";

export interface OcsAuditEntry {
  _id: string;
  action: string;
  module?: string;
  result?: string;
  risk?: string;
  actor: string;
  actorContext?: { displayName?: string; username?: string };
  targetId?: string;
  resource?: { id?: string; name?: string; type?: string };
  timestamp: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  source?: { ip?: string };
  operatorIp?: string;
}

export interface AuditListResponse {
  logs: OcsAuditEntry[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  summary: {
    totalToday: number;
    failures: number;
    criticalActions: number;
  };
}

export const ocsAuditApi = {
  list: (params?: Record<string, string | number>) => {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== "" && v !== undefined && v !== null) qs.set(k, String(v));
      }
    }
    const query = qs.toString();
    return fetcher(`/api/audit${query ? `?${query}` : ""}`);
  },

  get: (id: string) => fetcher(`/api/audit/${id}`),
};
