import type { CapabilityDecision } from "@/lib/permissions";

export type UserAccessRole = "root" | "operator" | "viewer";
export type UserAccessStatus = "active" | "disabled";
export type UserAccessDisplayStatus = UserAccessStatus | "locked";
export type PermissionEffect = "allow" | "approval_required" | "deny";
export type SortDirection = "asc" | "desc";

export type UserAccessRecord = {
  username: string;
  role?: string;
  status?: string;
  locked?: boolean;
};

export type UserQueryState = {
  q?: string;
  role?: string;
  status?: string;
  created?: string;
  createdFrom?: string;
  createdTo?: string;
  loginFrom?: string;
  loginTo?: string;
  createdBy?: string;
  locked?: string;
  neverLogin?: string;
  sort?: string;
  dir?: SortDirection;
  page?: number;
  pageSize?: number;
};

export type PermissionDiff = {
  key: string;
  before: PermissionEffect;
  after: PermissionEffect;
  category: "added" | "removed" | "allow_to_approval" | "approval_to_deny" | "changed";
};

export const USER_ACCESS_STATUS_META: Record<UserAccessDisplayStatus, { labelKey: string; tone: "success" | "neutral" | "danger" }> = {
  active: { labelKey: "users_status_enabled", tone: "success" },
  disabled: { labelKey: "users_status_disabled", tone: "neutral" },
  locked: { labelKey: "users_status_locked", tone: "danger" },
};

export function normalizeUserStatus(value: string | undefined): UserAccessStatus {
  return value === "disabled" ? "disabled" : "active";
}

export function getUserAccessStatusMeta(value: string | undefined, locked = false): {
  status: UserAccessDisplayStatus;
  labelKey: string;
  tone: "success" | "neutral" | "danger";
} {
  const status = locked ? "locked" : normalizeUserStatus(value);
  return { status, ...USER_ACCESS_STATUS_META[status] };
}

export function normalizePermissionEffect(decision: CapabilityDecision): PermissionEffect {
  if (decision === "approval") return "approval_required";
  if (decision === "deny") return "deny";
  return "allow";
}

export function permissionEffectToDecisionKey(effect: PermissionEffect) {
  if (effect === "approval_required") return "approval";
  if (effect === "deny") return "deny";
  return "allow";
}

export function isProtectedSystemUser(user: UserAccessRecord, currentUsername?: string | null) {
  return user.username === "admin" || user.username === currentUsername;
}

export function isBulkMutableUser(user: UserAccessRecord, currentUsername?: string | null) {
  return !isProtectedSystemUser(user, currentUsername) && user.role !== "root";
}

export function buildUserQueryString(state: UserQueryState) {
  const params = new URLSearchParams();
  if (state.q?.trim()) params.set("q", state.q.trim());
  if (state.role && state.role !== "all") params.set("role", state.role);
  if (state.status && state.status !== "all") params.set("status", state.status);
  if (state.created && state.created !== "all") params.set("created", state.created);
  if (state.createdFrom) params.set("createdFrom", state.createdFrom);
  if (state.createdTo) params.set("createdTo", state.createdTo);
  if (state.loginFrom) params.set("loginFrom", state.loginFrom);
  if (state.loginTo) params.set("loginTo", state.loginTo);
  if (state.createdBy?.trim()) params.set("createdBy", state.createdBy.trim());
  if (state.locked && state.locked !== "all") params.set("locked", state.locked);
  if (state.neverLogin && state.neverLogin !== "all") params.set("neverLogin", state.neverLogin);
  if (state.sort && state.sort !== "createdAt") params.set("sort", state.sort);
  if (state.dir && state.dir !== "desc") params.set("dir", state.dir);
  if (state.page && state.page > 1) params.set("page", String(state.page));
  if (state.pageSize && state.pageSize !== 10) params.set("pageSize", String(state.pageSize));
  return params.toString();
}

export function parsePositivePage(value: string | null, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function buildPermissionDiff(
  before: Record<string, PermissionEffect>,
  after: Record<string, PermissionEffect>,
): PermissionDiff[] {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return keys.flatMap((key) => {
    const from = before[key] || "deny";
    const to = after[key] || "deny";
    if (from === to) return [];
    const category =
      from === "deny" && to !== "deny" ? "added" :
      from === "allow" && to === "approval_required" ? "allow_to_approval" :
      from === "approval_required" && to === "deny" ? "approval_to_deny" :
      from !== "deny" && to === "deny" ? "removed" :
      "changed";
    return [{ key, before: from, after: to, category }];
  });
}
