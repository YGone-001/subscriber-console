/*
 * User-management response to view-model adapters.
 *
 * Live Go contracts:
 *
 *   GET /api/users?page&pageSize&q
 *     -> { items: [...], pagination: { page, pageSize, total, totalPages },
 *          stats: { total, active, administrators, locked }, assignableRoles: [...] }
 *   GET /api/users/{username}
 *     -> { user, normalizedRole, permissions, actions, assignableRoles, activity }
 *
 * Two things the ported user components must never do themselves: read the raw
 * legacy `role` field (the live data still reports `root`), and guess at the
 * pagination location.
 */
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asRecordOrNull,
  asText,
  asTimestamp,
  field,
  isFailureEnvelope,
  unwrapList,
  unwrapSummary,
  type UnknownRecord,
} from '../../lib/api/envelope';
import type { CanonicalRole } from '../../types/auth';

export type { CanonicalRole };

export type UserRoleViewModel = {
  /** The value the API reported, verbatim. */
  raw: string | null;
  /** The three-role model value, or null when the raw value is unrecognised. */
  canonical: CanonicalRole | null;
  /** True when the API reported a historical role that was mapped. */
  isLegacy: boolean;
};

/**
 * Historical role mapping. Kept identical to the backend normalisation so a
 * ported badge can never disagree with the server about a user's role.
 */
const LEGACY_ROLE_MAP: Record<string, CanonicalRole> = {
  root: 'admin',
  super_admin: 'admin',
  admin: 'admin',
  ops_admin: 'operator',
  operator: 'operator',
  auditor: 'viewer',
  viewer: 'viewer',
};

export const CANONICAL_ROLES: CanonicalRole[] = ['admin', 'operator', 'viewer'];

export function toUserRoleViewModel(raw: unknown): UserRoleViewModel {
  const value = asText(raw);
  if (value === null) return { raw: null, canonical: null, isLegacy: false };
  const canonical = LEGACY_ROLE_MAP[value] ?? null;
  return { raw: value, canonical, isLegacy: canonical !== null && canonical !== value };
}

export type UserListItemViewModel = {
  username: string | null;
  role: UserRoleViewModel;
  status: string | null;
  locked: boolean | null;
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  passwordChangedAt: string | null;
  sessionVersion: number | null;
  failedLoginAttempts: number | null;
};

export type UserStatsViewModel = {
  total: number | null;
  active: number | null;
  administrators: number | null;
  locked: number | null;
};

export type UserPaginationViewModel = {
  page: number | null;
  pageSize: number | null;
  total: number | null;
  totalPages: number | null;
};

export type UserListViewModel = {
  items: UserListItemViewModel[];
  pagination: UserPaginationViewModel | null;
  stats: UserStatsViewModel | null;
  assignableRoles: string[];
  /** False only when the payload could not be read at all. */
  readable: boolean;
};

function toUserListItem(record: UnknownRecord): UserListItemViewModel {
  const security = asRecord(record.security);
  return {
    username: field(record, 'username', asText),
    role: toUserRoleViewModel(record.role),
    status: field(record, 'status', asText),
    locked: field(record, 'locked', asBoolean),
    createdAt: field(record, 'createdAt', asTimestamp),
    createdBy: field(record, 'createdBy', asText),
    updatedAt: field(record, 'updatedAt', asTimestamp),
    lastLoginAt: field(security, 'lastLoginAt', asTimestamp),
    lastLoginIp: field(security, 'lastLoginIp', asText),
    passwordChangedAt: field(security, 'passwordChangedAt', asTimestamp),
    sessionVersion: field(security, 'sessionVersion', asNumber),
    failedLoginAttempts: field(security, 'failedLoginAttempts', asNumber),
  };
}

export function toUserListViewModel(payload: unknown): UserListViewModel {
  const list = unwrapList(payload, 'items', 'records', 'users');
  if (!list) {
    return { items: [], pagination: null, stats: null, assignableRoles: [], readable: false };
  }
  const items: UserListItemViewModel[] = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      items.push(toUserListItem(entry as UnknownRecord));
    }
  }
  const paginationSource = unwrapSummary(payload, 'pagination');
  const statsSource = unwrapSummary(payload, 'stats');
  const roles = asArray(asRecord(payload).assignableRoles) ?? [];
  return {
    items,
    pagination: paginationSource ? {
      page: field(paginationSource, 'page', asNumber),
      pageSize: field(paginationSource, 'pageSize', asNumber),
      total: field(paginationSource, 'total', asNumber),
      totalPages: field(paginationSource, 'totalPages', asNumber),
    } : null,
    stats: statsSource ? {
      total: field(statsSource, 'total', asNumber),
      active: field(statsSource, 'active', asNumber),
      administrators: field(statsSource, 'administrators', asNumber),
      locked: field(statsSource, 'locked', asNumber),
    } : null,
    assignableRoles: roles.filter((role): role is string => typeof role === 'string'),
    readable: true,
  };
}

export type UserActivityViewModel = {
  id: string | null;
  action: string | null;
  at: string | null;
  actor: string | null;
  detail: string | null;
};

export type UserDetailViewModel = {
  user: UserListItemViewModel | null;
  /** Server-normalised role. Authoritative for badges and permission gating. */
  normalizedRole: CanonicalRole | null;
  permissions: string[];
  /** Actions the current actor may perform on this user. */
  actions: string[];
  assignableRoles: string[];
  activity: UserActivityViewModel[];
};

/**
 * Adapt the user detail envelope.
 *
 * The user object and its capability metadata sit at DIFFERENT levels: the
 * record is nested under `user`, while `normalizedRole`, `permissions`,
 * `actions`, `assignableRoles` and `activity` sit on the envelope. Reading the
 * nested record and then looking for permissions on it silently yields empty
 * arrays, so both levels are read explicitly.
 */
export function toUserDetailViewModel(payload: unknown): UserDetailViewModel | null {
  if (isFailureEnvelope(payload)) return null;
  const envelope = asRecordOrNull(payload);
  if (!envelope) return null;

  const nested = asRecordOrNull(envelope.user) ?? asRecordOrNull(envelope.record) ?? asRecordOrNull(envelope.data);
  const userRecord = nested ?? envelope;
  if (Object.keys(userRecord).length === 0) return null;

  const readList = (key: string): string[] => {
    const values = asArray(envelope[key]) ?? asArray(userRecord[key]) ?? [];
    return values.filter((value): value is string => typeof value === 'string');
  };

  const activity = asArray(envelope.activity) ?? asArray(userRecord.activity) ?? [];

  return {
    user: toUserListItem(userRecord),
    normalizedRole: toUserRoleViewModel(envelope.normalizedRole ?? userRecord.normalizedRole ?? userRecord.role).canonical,
    permissions: readList('permissions'),
    actions: readList('actions'),
    assignableRoles: readList('assignableRoles'),
    activity: activity
      .filter((value): value is UnknownRecord => !!value && typeof value === 'object' && !Array.isArray(value))
      .map((entry) => ({
        id: field(entry, 'id', asText),
        action: field(entry, 'action', asText) ?? field(entry, 'type', asText),
        at: field(entry, 'at', asTimestamp) ?? field(entry, 'timestamp', asTimestamp) ?? field(entry, 'createdAt', asTimestamp),
        actor: field(entry, 'actor', asText) ?? field(entry, 'username', asText),
        detail: field(entry, 'detail', asText) ?? field(entry, 'message', asText),
      })),
  };
}
