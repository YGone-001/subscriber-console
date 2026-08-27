export type RoleKey = "root" | "super_admin" | "ops_admin" | "operator" | "auditor" | "viewer";
export type UserStatus = "active" | "disabled" | "locked";
export type DisplayUserStatus = UserStatus | "locked";

export type Capability =
  | "subscriber_write"
  | "policy_approve"
  | "balance_adjust"
  | "profile_rollback"
  | "rating_publish"
  | "approval_review"
  | "approval_execute"
  | "audit_view"
  | "audit_export"
  | "system_heal"
  | "user_admin";

export type CapabilityDecision = "allow" | "approval" | "export" | "deny";
export type PermissionEffect = "allow" | "approval_required" | "deny";

export interface SysUser {
  username: string;
  role: RoleKey;
  status: UserStatus;
  createdAt: string;
  createdBy: string;
  displayName?: string;
  email?: string;
  description?: string;
  lastLoginAt?: string;
  lastLoginIp?: string;
  locked?: boolean;
  userAgent?: string;
  updatedAt?: string;
  security?: {
    sessionVersion?: number;
    failedLoginAttempts?: number;
    lastLoginAt?: string;
    lastLoginIp?: string;
    passwordChangedAt?: string;
    lockedAt?: string;
    lockReason?: string;
  };
}

export type NewUserForm = {
  username: string;
  displayName: string;
  email: string;
  password: string;
  confirmPassword: string;
  role: RoleKey;
};

export type EditUserForm = {
  displayName: string;
  email: string;
  role: RoleKey;
  status: UserStatus;
  password: string;
};

export type DrawerMode = "closed" | "view" | "create" | "edit" | "resetPassword";
export type DetailTab = "basic" | "permissions" | "login" | "activity";
export type BulkAction = "enable" | "disable" | "assignRole";

export const VALID_ROLES: readonly RoleKey[] = ["root", "ops_admin", "operator", "auditor", "viewer"];
export const VALID_STATUS = ["active", "disabled", "locked"] as const satisfies readonly UserStatus[];
export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

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

export const CAPABILITY_DIMENSION_KEYS: Record<Capability, string> = {
  subscriber_write: "role_perm_dimension_edit",
  policy_approve: "role_perm_dimension_approve",
  balance_adjust: "role_perm_dimension_edit",
  profile_rollback: "role_perm_dimension_rollback",
  rating_publish: "role_perm_dimension_publish",
  approval_review: "role_perm_dimension_approve",
  approval_execute: "role_perm_dimension_approve",
  audit_view: "role_perm_dimension_view",
  audit_export: "role_perm_dimension_export",
  system_heal: "role_perm_dimension_system",
  user_admin: "role_perm_dimension_system",
};

export const DEFAULT_NEW_FORM: NewUserForm = {
  username: "",
  displayName: "",
  email: "",
  password: "",
  confirmPassword: "",
  role: "operator",
};

export const DEFAULT_EDIT_FORM: EditUserForm = {
  displayName: "",
  email: "",
  role: "operator",
  status: "active",
  password: "",
};

export const ROLE_STYLE: Record<RoleKey, { color: string; bg: string }> = {
  root: { color: "var(--danger)", bg: "var(--danger-soft)" },
  super_admin: { color: "var(--danger)", bg: "var(--danger-soft)" },
  ops_admin: { color: "var(--warning)", bg: "var(--warning-soft)" },
  auditor: { color: "var(--success)", bg: "var(--success-soft)" },
  operator: { color: "var(--warning)", bg: "var(--warning-soft)" },
  viewer: { color: "var(--primary)", bg: "var(--selection-soft)" },
};

export const STATUS_TONE_STYLE: Record<DisplayUserStatus, { color: string; bg: string }> = {
  active: { color: "var(--success)", bg: "var(--success-soft)" },
  disabled: { color: "var(--text-muted)", bg: "var(--neutral-soft)" },
  locked: { color: "var(--danger)", bg: "var(--danger-soft)" },
};
