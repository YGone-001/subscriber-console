import { fetcher } from "@/lib/fetcher";

export interface OcsApproval {
  _id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  status: string;
  requester: string;
  reviewer?: string;
  risk?: string;
  createdAt: string;
  updatedAt?: string;
  payload?: Record<string, unknown>;
}

export interface ApprovalListResponse {
  approvals: OcsApproval[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  summary: {
    canReview: number;
    awaiting: number;
    todayApproved: number;
    highRiskPending: number;
  };
}

export const ocsApprovalApi = {
  list: (params?: Record<string, string | number>) => {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== "" && v !== undefined && v !== null) qs.set(k, String(v));
      }
    }
    const query = qs.toString();
    return fetcher(`/api/approvals${query ? `?${query}` : ""}`);
  },

  get: (id: string) => fetcher(`/api/approvals/${id}`),
};
