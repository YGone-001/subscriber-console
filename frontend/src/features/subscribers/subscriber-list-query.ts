/*
 * Subscribers list-query contract.
 *
 * Persistent list state (page, size, sort, filters and the profile drill-down)
 * lives in the browser URL. The search draft deliberately does not: a search
 * term may be an IMSI or MSISDN, so serializing it would put a subscriber
 * identifier into browser history, shared links and diagnostics. Search remains
 * local and is only injected into the API request.
 *
 * The pure helpers below own parsing, validation, canonicalization and the
 * atomic transition rules. The React binding is a thin adapter over them.
 */
import type {
  SubscriberAccessStatus,
  SubscriberBalanceStatus,
  SubscriberContractStatus,
  SubscriberFilters,
  SubscriberProvisioningStatus,
} from './types';

export const SUBSCRIBER_URL_PARAMS = {
  page: 'page',
  size: 'size',
  sort: 'sort',
  order: 'order',
  access: 'access',
  contract: 'contract',
  provisioning: 'provisioning',
  plan: 'plan',
  balance: 'balance',
  profile: 'profile',
} as const;

export const SUBSCRIBER_PAGE_SIZES = [10, 20, 50] as const;
export type SubscriberPageSize = (typeof SUBSCRIBER_PAGE_SIZES)[number];

export const SUBSCRIBER_SORT_FIELDS = ['status', 'imsi', 'policy', 'usage', 'lastActive'] as const;
export type SubscriberSortField = (typeof SUBSCRIBER_SORT_FIELDS)[number];

export const SUBSCRIBER_SORT_ORDERS = ['asc', 'desc'] as const;
export type SubscriberSortOrder = (typeof SUBSCRIBER_SORT_ORDERS)[number];

export const SUBSCRIBER_ACCESS_VALUES = ['all', 'active', 'restricted'] as const;
export const SUBSCRIBER_CONTRACT_VALUES = ['all', 'active', 'suspended', 'terminated', 'none'] as const;
export const SUBSCRIBER_PROVISIONING_VALUES = [
  'all',
  'complete',
  'incomplete',
  'missing_contract',
  'missing_balance',
  'missing_plan',
] as const;
export const SUBSCRIBER_BALANCE_VALUES = ['all', 'exhausted', 'low', 'normal', 'available', 'missing'] as const;

export const DEFAULT_SUBSCRIBER_PAGE = 1;
export const DEFAULT_SUBSCRIBER_PAGE_SIZE: SubscriberPageSize = 10;
export const DEFAULT_SUBSCRIBER_SORT: SubscriberSortField = 'imsi';
export const DEFAULT_SUBSCRIBER_ORDER: SubscriberSortOrder = 'asc';

const MAX_PAGE = 1_000_000;
const MAX_PROFILE_LENGTH = 200;
const MAX_PLAN_ID_LENGTH = 128;
const SEARCH_TERM_PATTERN = /^\d{1,15}$/;

export type SubscriberListQuery = {
  page: number;
  size: SubscriberPageSize;
  sort: SubscriberSortField;
  order: SubscriberSortOrder;
  filters: SubscriberFilters;
  profile: string;
};

export type SubscriberListPatch = {
  page?: number;
  size?: number;
  sort?: string;
  order?: string;
  filters?: Partial<SubscriberFilters>;
  profile?: string | null;
};

export const DEFAULT_SUBSCRIBER_FILTERS: SubscriberFilters = {
  access: 'all',
  contract: 'all',
  provisioning: 'all',
  planId: '',
  balance: 'all',
};

export const DEFAULT_SUBSCRIBER_LIST_QUERY: SubscriberListQuery = {
  page: DEFAULT_SUBSCRIBER_PAGE,
  size: DEFAULT_SUBSCRIBER_PAGE_SIZE,
  sort: DEFAULT_SUBSCRIBER_SORT,
  order: DEFAULT_SUBSCRIBER_ORDER,
  filters: DEFAULT_SUBSCRIBER_FILTERS,
  profile: '',
};

export function isValidSubscriberSearchTerm(term: string): boolean {
  return term === '' || SEARCH_TERM_PATTERN.test(term);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function sanitizeText(value: string | null, maxLength: number): string {
  if (value == null) return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || hasControlCharacter(trimmed)) return '';
  return trimmed;
}

function sanitizePlanId(value: string | null): string {
  const trimmed = sanitizeText(value, MAX_PLAN_ID_LENGTH);
  if (!trimmed) return '';
  return /\s/.test(trimmed) ? '' : trimmed;
}

function parsePage(value: string | null): number {
  if (value == null || !/^\d+$/.test(value.trim())) return DEFAULT_SUBSCRIBER_PAGE;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) return DEFAULT_SUBSCRIBER_PAGE;
  return page;
}

function parsePageSize(value: string | null): SubscriberPageSize {
  if (value == null) return DEFAULT_SUBSCRIBER_PAGE_SIZE;
  const size = Number(value);
  return (SUBSCRIBER_PAGE_SIZES as readonly number[]).includes(size)
    ? (size as SubscriberPageSize)
    : DEFAULT_SUBSCRIBER_PAGE_SIZE;
}

function parseEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  const candidate = value?.trim() ?? '';
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T) : fallback;
}

/** Parse a query string into the canonical list state. Never throws. */
export function parseSubscriberListQuery(search: string): SubscriberListQuery {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return { ...DEFAULT_SUBSCRIBER_LIST_QUERY, filters: { ...DEFAULT_SUBSCRIBER_LIST_QUERY.filters } };
  }
  return {
    page: parsePage(params.get(SUBSCRIBER_URL_PARAMS.page)),
    size: parsePageSize(params.get(SUBSCRIBER_URL_PARAMS.size)),
    sort: parseEnum(params.get(SUBSCRIBER_URL_PARAMS.sort), SUBSCRIBER_SORT_FIELDS, DEFAULT_SUBSCRIBER_SORT),
    order: parseEnum(params.get(SUBSCRIBER_URL_PARAMS.order), SUBSCRIBER_SORT_ORDERS, DEFAULT_SUBSCRIBER_ORDER),
    filters: {
      access: parseEnum<SubscriberAccessStatus>(
        params.get(SUBSCRIBER_URL_PARAMS.access),
        SUBSCRIBER_ACCESS_VALUES,
        'all',
      ),
      contract: parseEnum<SubscriberContractStatus>(
        params.get(SUBSCRIBER_URL_PARAMS.contract),
        SUBSCRIBER_CONTRACT_VALUES,
        'all',
      ),
      provisioning: parseEnum<SubscriberProvisioningStatus>(
        params.get(SUBSCRIBER_URL_PARAMS.provisioning),
        SUBSCRIBER_PROVISIONING_VALUES,
        'all',
      ),
      planId: sanitizePlanId(params.get(SUBSCRIBER_URL_PARAMS.plan)),
      balance: parseEnum<SubscriberBalanceStatus>(
        params.get(SUBSCRIBER_URL_PARAMS.balance),
        SUBSCRIBER_BALANCE_VALUES,
        'all',
      ),
    },
    profile: sanitizeText(params.get(SUBSCRIBER_URL_PARAMS.profile), MAX_PROFILE_LENGTH),
  };
}

/** Normalize an in-memory state object with the same rules used for parsing. */
export function normalizeSubscriberListQuery(query: SubscriberListQuery): SubscriberListQuery {
  return {
    page: Number.isSafeInteger(query.page) && query.page >= 1 && query.page <= MAX_PAGE
      ? query.page
      : DEFAULT_SUBSCRIBER_PAGE,
    size: parsePageSize(String(query.size)),
    sort: parseEnum(query.sort, SUBSCRIBER_SORT_FIELDS, DEFAULT_SUBSCRIBER_SORT),
    order: parseEnum(query.order, SUBSCRIBER_SORT_ORDERS, DEFAULT_SUBSCRIBER_ORDER),
    filters: {
      access: parseEnum(query.filters.access, SUBSCRIBER_ACCESS_VALUES, 'all'),
      contract: parseEnum(query.filters.contract, SUBSCRIBER_CONTRACT_VALUES, 'all'),
      provisioning: parseEnum(query.filters.provisioning, SUBSCRIBER_PROVISIONING_VALUES, 'all'),
      planId: sanitizePlanId(query.filters.planId),
      balance: parseEnum(query.filters.balance, SUBSCRIBER_BALANCE_VALUES, 'all'),
    },
    profile: sanitizeText(query.profile, MAX_PROFILE_LENGTH),
  };
}

/**
 * Canonical serialization. Default values are omitted, so equivalent states
 * always produce byte-identical URLs and a parsed URL round-trips unchanged.
 */
export function serializeSubscriberListQuery(query: SubscriberListQuery): string {
  const normalized = normalizeSubscriberListQuery(query);
  const params = new URLSearchParams();
  if (normalized.page !== DEFAULT_SUBSCRIBER_PAGE) params.set(SUBSCRIBER_URL_PARAMS.page, String(normalized.page));
  if (normalized.size !== DEFAULT_SUBSCRIBER_PAGE_SIZE) params.set(SUBSCRIBER_URL_PARAMS.size, String(normalized.size));
  if (normalized.sort !== DEFAULT_SUBSCRIBER_SORT) params.set(SUBSCRIBER_URL_PARAMS.sort, normalized.sort);
  if (normalized.order !== DEFAULT_SUBSCRIBER_ORDER) params.set(SUBSCRIBER_URL_PARAMS.order, normalized.order);
  if (normalized.filters.access !== 'all') params.set(SUBSCRIBER_URL_PARAMS.access, normalized.filters.access);
  if (normalized.filters.contract !== 'all') params.set(SUBSCRIBER_URL_PARAMS.contract, normalized.filters.contract);
  if (normalized.filters.provisioning !== 'all') params.set(SUBSCRIBER_URL_PARAMS.provisioning, normalized.filters.provisioning);
  if (normalized.filters.planId) params.set(SUBSCRIBER_URL_PARAMS.plan, normalized.filters.planId);
  if (normalized.filters.balance !== 'all') params.set(SUBSCRIBER_URL_PARAMS.balance, normalized.filters.balance);
  if (normalized.profile) params.set(SUBSCRIBER_URL_PARAMS.profile, normalized.profile);
  const search = params.toString();
  return search ? `?${search}` : '';
}

/**
 * Apply a state patch as one transition.
 *
 * Any non-page change resets pagination to page 1 in the same returned state,
 * so callers can never emit a URL that first points at page N of a new filter
 * and then corrects itself. An explicit `page` is honoured only on its own.
 */
export function applySubscriberListPatch(
  current: SubscriberListQuery,
  patch: SubscriberListPatch,
): SubscriberListQuery {
  const next: SubscriberListQuery = {
    ...current,
    filters: { ...current.filters },
  };
  let changedNonPage = false;

  if (patch.size !== undefined) {
    const size = parsePageSize(String(patch.size));
    if (size !== next.size) changedNonPage = true;
    next.size = size;
  }
  if (patch.sort !== undefined) {
    const sort = parseEnum(patch.sort, SUBSCRIBER_SORT_FIELDS, DEFAULT_SUBSCRIBER_SORT);
    if (sort !== next.sort) changedNonPage = true;
    next.sort = sort;
  }
  if (patch.order !== undefined) {
    const order = parseEnum(patch.order, SUBSCRIBER_SORT_ORDERS, DEFAULT_SUBSCRIBER_ORDER);
    if (order !== next.order) changedNonPage = true;
    next.order = order;
  }
  if (patch.filters !== undefined) {
    const filters: SubscriberFilters = {
      ...next.filters,
      ...patch.filters,
    };
    const normalizedFilters: SubscriberFilters = {
      access: parseEnum(filters.access, SUBSCRIBER_ACCESS_VALUES, 'all'),
      contract: parseEnum(filters.contract, SUBSCRIBER_CONTRACT_VALUES, 'all'),
      provisioning: parseEnum(filters.provisioning, SUBSCRIBER_PROVISIONING_VALUES, 'all'),
      planId: sanitizePlanId(filters.planId),
      balance: parseEnum(filters.balance, SUBSCRIBER_BALANCE_VALUES, 'all'),
    };
    if (JSON.stringify(normalizedFilters) !== JSON.stringify(next.filters)) changedNonPage = true;
    next.filters = normalizedFilters;
  }
  if (patch.profile !== undefined) {
    const profile = sanitizeText(patch.profile, MAX_PROFILE_LENGTH);
    if (profile !== next.profile) changedNonPage = true;
    next.profile = profile;
  }

  if (patch.page !== undefined) {
    next.page = parsePage(String(patch.page));
  } else if (changedNonPage) {
    next.page = DEFAULT_SUBSCRIBER_PAGE;
  }
  return normalizeSubscriberListQuery(next);
}

/** Whether an update would change the canonical URL. */
export function isSubscriberListQueryEqual(a: SubscriberListQuery, b: SubscriberListQuery): boolean {
  return serializeSubscriberListQuery(a) === serializeSubscriberListQuery(b);
}

/**
 * API request for the active list state. Search is local, so it is passed
 * separately and only after the page's validation accepted it.
 */
export function buildSubscriberListApiUrl(query: SubscriberListQuery, searchTerm = ''): string {
  const normalized = normalizeSubscriberListQuery(query);
  const params = new URLSearchParams({
    detail: 'true',
    page: String(normalized.page),
    limit: String(normalized.size),
    searchBy: 'auto',
    sortField: normalized.sort,
    sortDirection: normalized.order,
  });
  if (searchTerm && isValidSubscriberSearchTerm(searchTerm)) params.set('q', searchTerm);
  if (normalized.filters.access !== 'all') params.set('status', normalized.filters.access);
  if (normalized.filters.contract !== 'all') params.set('contractStatus', normalized.filters.contract);
  if (normalized.filters.provisioning !== 'all') params.set('provisioning', normalized.filters.provisioning);
  if (normalized.filters.planId) params.set('planId', normalized.filters.planId);
  if (normalized.filters.balance !== 'all') params.set('balanceStatus', normalized.filters.balance);
  if (normalized.profile) params.set('profile', normalized.profile);
  return `/api/subscribers?${params.toString()}`;
}

/**
 * Selection scope is the query identity a selection belongs to. Page is
 * deliberately excluded: the established UI preserves selection while paging
 * inside one query. Search is included so typing invalidates selection
 * immediately, exactly like the previous local-state toolbar did.
 */
export function subscriberSelectionScopeKey(query: SubscriberListQuery, searchDraft: string): string {
  const normalized = normalizeSubscriberListQuery(query);
  return JSON.stringify({
    search: searchDraft.trim(),
    size: normalized.size,
    sort: normalized.sort,
    order: normalized.order,
    filters: normalized.filters,
    profile: normalized.profile,
  });
}

/** Page clamp after a read reveals a smaller result set. Never changes filters. */
export function clampSubscriberPage(query: SubscriberListQuery, total: number, size: number): number {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, size)));
  return Math.min(Math.max(1, query.page), totalPages);
}