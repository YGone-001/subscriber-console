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
