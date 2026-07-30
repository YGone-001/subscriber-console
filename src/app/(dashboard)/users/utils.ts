import { type CreatedFilter, type RoleFilter, type StatusFilter, type BinaryFilter, type RoleKey, type UserStatus, type DisplayUserStatus, VALID_ROLES, VALID_STATUS, PAGE_SIZE_OPTIONS, SORT_KEYS, type SortKey, type SortDirection, SORT_DIRECTIONS } from "./types";

export function isRoleKey(value: string): value is RoleKey {
  return VALID_ROLES.includes(value as RoleKey);
}

export function isUserStatus(value: string): value is UserStatus {
  return VALID_STATUS.includes(value as UserStatus);
}

export function isRoleFilter(value: string | null): value is RoleFilter {
  return value === "all" || (typeof value === "string" && isRoleKey(value));
}

export function isStatusFilter(value: string | null): value is StatusFilter {
  return value === "all" || (typeof value === "string" && isUserStatus(value));
}

export function isCreatedFilter(value: string | null): value is CreatedFilter {
  return value === "all" || value === "today" || value === "7d" || value === "30d";
}

export function isBinaryFilter(value: string | null): value is BinaryFilter {
  return value === "all" || value === "yes" || value === "no";
}

export function isSortKey(value: string | null): value is SortKey {
  return typeof value === "string" && (SORT_KEYS as readonly string[]).includes(value);
}

export function isSortDirection(value: string | null): value is SortDirection {
  return typeof value === "string" && (SORT_DIRECTIONS as readonly string[]).includes(value);
}

export function normalizeRole(value: string): RoleKey {
  return isRoleKey(value) ? value : "viewer";
}

export function normalizeStatus(value: string | undefined): UserStatus {
  return value && isUserStatus(value) ? value : "active";
}

export function normalizePageSize(value: string | null): number {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.includes(parsed as any) ? parsed : 10;
}

export function formatDateTime(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

export function displayValue(value?: string) {
  return value?.trim() || "--";
}

export function matchesCreatedFilter(createdAt: string, filter: CreatedFilter) {
  if (filter === "all") return true;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  if (filter === "today") {
    return date.toDateString() === now.toDateString();
  }

  const days = filter === "7d" ? 7 : 30;
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  return date.getTime() >= since;
}
