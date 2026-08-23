export {
  CAPABILITY_DIMENSION_KEYS,
  CAPABILITY_LABEL_KEYS,
  DEFAULT_EDIT_FORM,
  DEFAULT_NEW_FORM,
  PAGE_SIZE_OPTIONS,
  ROLE_STYLE,
  STATUS_TONE_STYLE,
  USERNAME_PATTERN,
  VALID_ROLES,
  VALID_STATUS,
} from "@/types/iam";

export type {
  BulkAction,
  Capability,
  CapabilityDecision,
  DetailTab,
  DisplayUserStatus,
  DrawerMode,
  EditUserForm,
  NewUserForm,
  PermissionEffect,
  RoleKey,
  SysUser,
  UserStatus,
} from "@/types/iam";

export type ApprovalMetricResponse = {
  pending?: number;
};

export type AuditLogRecord = {
  id: string;
  timestamp: string;
  level: "info" | "warning";
  action: string;
  targetId: string;
  operatorIp: string;
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

export type RoleFilter = import("@/types/iam").RoleKey | "all";
export type StatusFilter = import("@/types/iam").UserStatus | "all";
export type CreatedFilter = "all" | "today" | "7d" | "30d";
export type BinaryFilter = "all" | "yes" | "no";
export type SortKey = "username" | "status" | "createdAt" | "lastLoginAt";
export type SortDirection = "asc" | "desc";

export type PendingStatusChange = {
  username: string;
  status: import("@/types/iam").UserStatus;
};

export type PendingBulkAction = {
  action: import("@/types/iam").BulkAction;
  usernames: string[];
  role?: import("@/types/iam").RoleKey;
};

export type UsernameAvailability = "idle" | "checking" | "available" | "taken" | "invalid" | "error";

export type BulkProgressItemStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export type BulkProgressItem = {
  username: string;
  status: BulkProgressItemStatus;
  reason?: string;
};

export type BulkProgressState = {
  action: import("@/types/iam").BulkAction;
  items: BulkProgressItem[];
  cancelRequested: boolean;
  completed: boolean;
};

export type PendingUpdate = {
  username: string;
  payload: {
    role?: import("@/types/iam").RoleKey;
    status?: import("@/types/iam").UserStatus;
    password?: string;
  };
  impact: string;
};

export const SORT_KEYS: readonly SortKey[] = ["username", "status", "createdAt", "lastLoginAt"];
export const SORT_DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];
