import { fetcher, handleSessionExpiry } from "@/lib/fetcher";
import type { RoleKey, SysUser, UserStatus } from "@/types/iam";

// --- Types ---

export interface UserListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  role?: string;
  status?: string;
  sort?: string;
  order?: string;
}

export interface UserPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface UserStats {
  total: number;
  active: number;
  administrators: number;
  locked: number;
}

export interface UserListResponse {
  items: SysUser[];
  pagination: UserPagination;
  stats: UserStats;
  assignableRoles: RoleKey[];
}

export interface UserDetailResponse {
  user: SysUser;
  normalizedRole: string;
  permissions: string[];
  actions: string[];
  assignableRoles: RoleKey[];
  activity: Array<Record<string, unknown>>;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
  role: RoleKey;
}

export interface UpdateUserPayload {
  displayName?: string;
  email?: string;
  role?: RoleKey;
  status?: UserStatus;
  password?: string;
  reason?: string;
}

export interface ApiError extends Error {
  status: number;
  code?: string;
}

// --- Helpers ---

const BASE = "/api/users";

async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  handleSessionExpiry(res.status);
  let message = fallback;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    message = body.error || fallback;
    code = body.code;
  } catch {
    message = res.statusText || fallback;
  }
  const err = new Error(message) as ApiError;
  err.status = res.status;
  err.code = code;
  return err;
}

// --- API Client ---

export const usersApi = {
  /** GET /api/users */
  list(params: UserListParams = {}): Promise<UserListResponse> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== "" && v !== undefined && v !== null) qs.set(k, String(v));
    }
    const query = qs.toString();
    return fetcher(query ? `${BASE}?${query}` : BASE);
  },

  /** GET /api/users/{username} */
  get(username: string): Promise<UserDetailResponse> {
    return fetcher(`${BASE}/${encodeURIComponent(username)}`);
  },

  /** POST /api/users */
  async create(payload: CreateUserPayload): Promise<SysUser> {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await toApiError(res, "Failed to create user.");
    return res.json();
  },

  /** PATCH /api/users/{username} */
  async update(username: string, payload: UpdateUserPayload): Promise<SysUser> {
    const res = await fetch(`${BASE}/${encodeURIComponent(username)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await toApiError(res, "Failed to update user.");
    return res.json();
  },

  /** POST /api/users/{username}/disable */
  async disable(username: string, reason?: string): Promise<SysUser> {
    const res = await fetch(`${BASE}/${encodeURIComponent(username)}/disable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw await toApiError(res, "Failed to disable user.");
    return res.json();
  },

  /** POST /api/users/{username}/password-reset */
  async resetPassword(username: string, password: string, reason?: string): Promise<void> {
    const res = await fetch(`${BASE}/${encodeURIComponent(username)}/password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, reason }),
    });
    if (!res.ok) throw await toApiError(res, "Failed to reset password.");
  },
};
