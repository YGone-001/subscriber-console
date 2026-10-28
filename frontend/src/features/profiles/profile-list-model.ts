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
export const PROFILE_SORT_FIELDS = ['name', 'updatedAt', 'subscriberCount', 'sliceCount'] as const;
export type ProfileSortField = (typeof PROFILE_SORT_FIELDS)[number];
export type ProfileSortDirection = 'asc' | 'desc';

export const DEFAULT_PROFILE_SORT_FIELD: ProfileSortField = 'name';

/* A name ranking reads alphabetically first, a recency or volume ranking reads
 * highest-first. The server resolves the same default when `order` is absent, and
 * the page needs it to decide what the first click on a column means. */
export function defaultProfileSortDirection(field: ProfileSortField): ProfileSortDirection {
  return field === 'name' ? 'asc' : 'desc';
}

export function profileSortFromParam(value: string | undefined): ProfileSortField {
  return (PROFILE_SORT_FIELDS as readonly string[]).includes(value ?? '')
    ? (value as ProfileSortField)
    : DEFAULT_PROFILE_SORT_FIELD;
}

export function profileDirectionFromParam(value: string | undefined): ProfileSortDirection | null {
  return value === 'asc' || value === 'desc' ? value : null;
}

/* Only a non-default choice goes on the wire, so the untouched view keeps the one
 * read key it has always had and stays a cache hit. */
export function profilesListReadUrl(
  field: ProfileSortField,
  direction: ProfileSortDirection,
): string {
  const params = new URLSearchParams();
  if (field !== DEFAULT_PROFILE_SORT_FIELD) params.set('sort', field);
  if (direction !== defaultProfileSortDirection(field)) params.set('order', direction);
  const query = params.toString();
  return query ? `/api/profiles?${query}` : '/api/profiles';
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
