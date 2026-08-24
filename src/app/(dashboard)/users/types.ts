import { type Capability } from "@/lib/permissions";
export interface SysUser {
  username: string;
  role: string;
  status: string;
  createdAt: string;
  createdBy: string;
  displayName?: string;
  email?: string;
  description?: string;
  lastLoginAt?: string;
  lastLoginIp?: string;
  locked?: boolean;
  userAgent?: string;
}

export type ApprovalMetricResponse = {
  pending?: number;
};

export type AuditLogRecord = {
  id: string;
  timestamp: string;
  level: "info" | "warning";
  action: string;
  targetId: string;
  actor?: string;
  operatorIp: string;
  correlationId?: string;
  approvalId?: string;
  oldData?: unknown;
  newData?: unknown;
};

export type AuditLogResponse = {
  logs: AuditLogRecord[];
  filteredTotal: number;
  totalScanned: number;
};

export type Notice = {
  type: "success" | "error" | "info";
  text: string;
};

export type RoleKey = "root" | "operator" | "viewer";
export type UserStatus = "active" | "disabled";
export type RoleFilter = RoleKey | "all";
export type StatusFilter = UserStatus | "all";
export type DisplayUserStatus = UserStatus | "locked";
export type CreatedFilter = "all" | "today" | "7d" | "30d";
export type BinaryFilter = "all" | "yes" | "no";
export type SortKey = "username" | "status" | "createdAt" | "lastLoginAt";
export type SortDirection = "asc" | "desc";
export type DrawerMode = "closed" | "view" | "create" | "edit";
export type DetailTab = "basic" | "permissions" | "login" | "activity";
export type BulkAction = "enable" | "disable" | "assignRole";

export type NewUserForm = {
  username: string;
  password: string;
  confirmPassword: string;
  role: RoleKey;
};

export type EditUserForm = {
  role: RoleKey;
  status: UserStatus;
  password: string;
};

export type PendingStatusChange = {
  username: string;
  status: UserStatus;
};

export type PendingBulkAction = {
  action: BulkAction;
  usernames: string[];
  role?: RoleKey;
};

export type PendingUpdate = {
  username: string;
  payload: {
    role?: RoleKey;
    status?: UserStatus;
    password?: string;
  };
  impact: string;
};

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;
export const VALID_ROLES: readonly RoleKey[] = ["root", "operator", "viewer"];
export const VALID_STATUS: readonly UserStatus[] = ["active", "disabled"];
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export const SORT_KEYS: readonly SortKey[] = ["username", "status", "createdAt", "lastLoginAt"];
export const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

export const CAPABILITY_LABEL_KEYS: Record<Capability, string> = {
  subscriber_write: "users_cap_action_subscriber_write",
  policy_approve: "users_cap_action_policy_approve",
  balance_adjust: "users_cap_action_balance_adjust",
  profile_rollback: "users_cap_action_profile_rollback",
  rating_publish: "users_cap_action_rating_publish",
  approval_review: "users_cap_action_approval_review",
  approval_execute: "users_cap_action_approval_execute",
  audit_view: "users_cap_action_audit_view",
  audit_export: "users_cap_action_audit_export",
  system_heal: "users_cap_action_system_heal",
  user_admin: "users_cap_action_user_admin",
};

export const DEFAULT_NEW_FORM: NewUserForm = {
  username: "",
  password: "",
  confirmPassword: "",
  role: "operator",
};

export const DEFAULT_EDIT_FORM: EditUserForm = {
  role: "operator",
  status: "active",
  password: "",
};

export const ROLE_STYLE: Record<RoleKey, { color: string; bg: string }> = {
  root: { color: "var(--danger)", bg: "var(--danger-soft)" },
  operator: { color: "var(--warning)", bg: "var(--warning-soft)" },
  viewer: { color: "var(--primary)", bg: "var(--selection-soft)" },
};

export const STATUS_TONE_STYLE: Record<DisplayUserStatus, { color: string; bg: string }> = {
  active: { color: "var(--success)", bg: "var(--success-soft)" },
  disabled: { color: "var(--text-muted)", bg: "var(--neutral-soft)" },
  locked: { color: "var(--danger)", bg: "var(--danger-soft)" },
};
