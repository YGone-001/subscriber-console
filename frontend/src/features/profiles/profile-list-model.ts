/*
 * List filtering for the template surface. Every predicate reads a field the
 * backend actually returns; nothing is inferred from the template name.
 */

export type ProfileListFilter = 'all' | 'withBilling' | 'withoutBilling' | 'unassigned';

/* The URL carries a stable value per filter so a shared link survives wording
 * changes in the labels. */
const FILTER_PARAM_VALUES: Record<Exclude<ProfileListFilter, 'all'>, string> = {
  withBilling: 'configured',
  withoutBilling: 'missing',
  unassigned: 'unlinked',
};
const FILTER_FROM_PARAM: Record<string, ProfileListFilter> = {
  configured: 'withBilling',
  missing: 'withoutBilling',
  unlinked: 'unassigned',
};

export function profileFilterFromParam(value: string | null | undefined): ProfileListFilter {
  return FILTER_FROM_PARAM[value ?? ''] ?? 'all';
}

export function profileFilterToParam(filter: ProfileListFilter): string {
  return filter === 'all' ? '' : FILTER_PARAM_VALUES[filter];
}

export type ProfileListEntry = {
  name: string;
  title?: string;
  ocsDefaultsConfigured?: boolean;
  subscriberCount?: number;
  impactedSubscribers?: number;
};

export function linkedSubscriberCount(entry: ProfileListEntry): number {
  return entry.subscriberCount ?? entry.impactedSubscribers ?? 0;
}

export function matchesProfileListFilter(entry: ProfileListEntry, filter: ProfileListFilter): boolean {
  switch (filter) {
    case 'withBilling':
      return entry.ocsDefaultsConfigured === true;
    case 'withoutBilling':
      return entry.ocsDefaultsConfigured !== true;
    case 'unassigned':
      return linkedSubscriberCount(entry) === 0;
    default:
      return true;
  }
}

export function filterProfileList<T extends ProfileListEntry>(
  entries: T[],
  query: string,
  filter: ProfileListFilter,
): T[] {
  const normalized = query.trim().toLowerCase();
  return entries.filter((entry) => {
    const matchesQuery = normalized === ''
      || entry.name.toLowerCase().includes(normalized)
      || String(entry.title || '').toLowerCase().includes(normalized);
    return matchesQuery && matchesProfileListFilter(entry, filter);
  });
}

export function countProfilesWithoutBilling(entries: ProfileListEntry[]): number {
  return entries.filter((entry) => entry.ocsDefaultsConfigured !== true).length;
}

/* The server owns the ordering of the template list and refuses a spelling it does
 * not recognise (parseProfileListOrder in backend/internal/profile/repository.go).
 * These are the fields a reader may ask for; anything else is a client mistake, not
 * a reason to answer with a different ranking. */
export const PROFILE_SORT_FIELDS = [
  'name',
  'title',
  'createdAt',
  'updatedAt',
  'subscriberCount',
  'sliceCount',
  'sessionCount',
  'pccRuleCount',
] as const;
export type ProfileSortField = (typeof PROFILE_SORT_FIELDS)[number];
export type ProfileSortDirection = 'asc' | 'desc';

export const DEFAULT_PROFILE_SORT_FIELD: ProfileSortField = 'name';
export const PROFILE_LIST_PAGE_SIZE = 50;

/* A name or title ranking reads alphabetically first, a date or counter ranking
 * reads highest-first. The server resolves the same default when `order` is absent,
 * and the page needs it to decide what the first click on a column means. */
export function defaultProfileSortDirection(field: ProfileSortField): ProfileSortDirection {
  return field === 'name' || field === 'title' ? 'asc' : 'desc';
}

export function profileSortFromParam(value: string | undefined): ProfileSortField {
  return (PROFILE_SORT_FIELDS as readonly string[]).includes(value ?? '')
    ? (value as ProfileSortField)
    : DEFAULT_PROFILE_SORT_FIELD;
}

export function profileDirectionFromParam(value: string | undefined): ProfileSortDirection | null {
  return value === 'asc' || value === 'desc' ? value : null;
}

export interface ProfilesListQuery {
  field: ProfileSortField;
  direction: ProfileSortDirection;
  query?: string;
  billing?: string;
  limit?: number;
  cursor?: string | null;
}

/* Only non-default choices go on the wire, so the untouched view keeps the read
 * key it has always had. The filter facets travel with the page because the server
 * owns them: filtering a page on the client would hide matches it never received. */
export function profilesListReadUrl(input: ProfilesListQuery): string {
  const params = new URLSearchParams();
  if (input.field !== DEFAULT_PROFILE_SORT_FIELD) params.set('sort', input.field);
  if (input.direction !== defaultProfileSortDirection(input.field)) params.set('order', input.direction);
  const query = (input.query ?? '').trim();
  if (query) params.set('q', query);
  if (input.billing) params.set('billing', input.billing);
  if (input.limit) params.set('limit', String(input.limit));
  if (input.cursor) params.set('cursor', input.cursor);
  const search = params.toString();
  return search ? `/api/profiles?${search}` : '/api/profiles';
}

/* The same column flips; a new column starts from its own default direction. */
export function nextProfileSort(
  current: { field: ProfileSortField; direction: ProfileSortDirection },
  target: ProfileSortField,
): { field: ProfileSortField; direction: ProfileSortDirection } {
  if (current.field !== target) {
    return { field: target, direction: defaultProfileSortDirection(target) };
  }
  return { field: target, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}
