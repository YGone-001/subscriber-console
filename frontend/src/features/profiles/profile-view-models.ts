/*
 * Profile (configuration template) response to view-model adapters.
 *
 * Live Go contracts:
 *
 *   GET /api/profiles
 *     -> { profiles: [...], summary: { totalProfiles, totalGovernedSubscribers,
 *          activeSubscribers, suspendedSubscribers, restrictedSubscribers,
 *          unassignedProfiles } }
 *   GET /api/profiles/{name}            -> { profile: {...} } or a bare profile
 *   GET /api/profiles/{name}/stats      -> statistics for one profile
 *   GET /api/profiles/{name}/versions   -> { versions: [...] }
 *
 * The summary is independent of the list: an empty `profiles` array with a
 * populated `summary` is a valid, meaningful payload and must not be collapsed
 * into an empty page.
 */
import {
  asArray,
  asNumber,
  asRecord,
  asText,
  asTimestamp,
  field,
  unwrapList,
  unwrapRecord,
  unwrapSummary,
  type UnknownRecord,
} from '../../lib/api/envelope';

export type ProfileSummaryViewModel = {
  totalProfiles: number | null;
  totalGovernedSubscribers: number | null;
  activeSubscribers: number | null;
  suspendedSubscribers: number | null;
  restrictedSubscribers: number | null;
  unassignedProfiles: number | null;
};

export type ProfileListItemViewModel = {
  name: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  version: number | null;
  subscriberCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ProfileListViewModel = {
  profiles: ProfileListItemViewModel[];
  summary: ProfileSummaryViewModel | null;
  /** False only when the payload could not be read at all. */
  readable: boolean;
};

export type ProfileStatsViewModel = {
  subscriberCount: number | null;
  activeSubscribers: number | null;
  suspendedSubscribers: number | null;
  restrictedSubscribers: number | null;
  sliceCount: number | null;
  sessionCount: number | null;
  pccRuleCount: number | null;
};

export type ProfileVersionViewModel = {
  versionId: string | null;
  version: number | null;
  createdAt: string | null;
  createdBy: string | null;
  note: string | null;
};

function toProfileListItem(record: UnknownRecord): ProfileListItemViewModel {
  return {
    name: field(record, 'name', asText),
    title: field(record, 'title', asText),
    description: field(record, 'description', asText),
    status: field(record, 'status', asText),
    version: field(record, 'version', asNumber),
    subscriberCount: field(record, 'subscriberCount', asNumber) ?? field(record, 'subscriber_count', asNumber),
    createdAt: field(record, 'createdAt', asTimestamp) ?? field(record, 'created_at', asTimestamp),
    updatedAt: field(record, 'updatedAt', asTimestamp) ?? field(record, 'updated_at', asTimestamp),
  };
}

function toSummary(record: UnknownRecord | null): ProfileSummaryViewModel | null {
  if (!record) return null;
  return {
    totalProfiles: field(record, 'totalProfiles', asNumber),
    totalGovernedSubscribers: field(record, 'totalGovernedSubscribers', asNumber),
    activeSubscribers: field(record, 'activeSubscribers', asNumber),
    suspendedSubscribers: field(record, 'suspendedSubscribers', asNumber),
    restrictedSubscribers: field(record, 'restrictedSubscribers', asNumber),
    unassignedProfiles: field(record, 'unassignedProfiles', asNumber),
  };
}

export function toProfileListViewModel(payload: unknown): ProfileListViewModel {
  const list = unwrapList(payload, 'profiles', 'records', 'items');
  const summary = toSummary(unwrapSummary(payload, 'summary'));
  if (!list) return { profiles: [], summary, readable: false };
  const profiles: ProfileListItemViewModel[] = [];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      profiles.push(toProfileListItem(entry as UnknownRecord));
    }
  }
  return { profiles, summary, readable: true };
}

export function toProfileDetailViewModel(payload: unknown): ProfileListItemViewModel | null {
  const record = unwrapRecord(payload, 'profile', 'record', 'data');
  if (!record) return null;
  return toProfileListItem(record);
}

export function toProfileStatsViewModel(payload: unknown): ProfileStatsViewModel | null {
  const record = unwrapRecord(payload, 'stats', 'summary', 'record', 'data');
  if (!record) return null;
  return {
    subscriberCount: field(record, 'subscriberCount', asNumber) ?? field(record, 'subscriber_count', asNumber),
    activeSubscribers: field(record, 'activeSubscribers', asNumber),
    suspendedSubscribers: field(record, 'suspendedSubscribers', asNumber),
    restrictedSubscribers: field(record, 'restrictedSubscribers', asNumber),
    sliceCount: field(record, 'sliceCount', asNumber),
    sessionCount: field(record, 'sessionCount', asNumber),
    pccRuleCount: field(record, 'pccRuleCount', asNumber),
  };
}

export function toProfileVersionsViewModel(payload: unknown): ProfileVersionViewModel[] {
  const list = unwrapList(payload, 'versions', 'records', 'items') ?? [];
  const versions: ProfileVersionViewModel[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as UnknownRecord;
    versions.push({
      versionId: field(record, 'versionId', asText) ?? field(record, 'id', asText),
      version: field(record, 'version', asNumber),
      createdAt: field(record, 'createdAt', asTimestamp) ?? field(record, 'created_at', asTimestamp),
      createdBy: field(record, 'createdBy', asText),
      note: field(record, 'note', asText) ?? field(record, 'message', asText),
    });
  }
  return versions;
}

/** Metric-strip items derived from the summary, preserving null vs zero. */
export function profileSummaryMetrics(summary: ProfileSummaryViewModel | null): Array<{ key: string; value: number | null }> {
  if (!summary) return [];
  return [
    { key: 'profiles', value: summary.totalProfiles },
    { key: 'governed', value: summary.totalGovernedSubscribers },
    { key: 'active', value: summary.activeSubscribers },
    { key: 'suspended', value: summary.suspendedSubscribers },
    { key: 'restricted', value: summary.restrictedSubscribers },
    { key: 'unassigned', value: summary.unassignedProfiles },
  ];
}

/** The declared profile names on a raw profile record, when present. */
export function profileSlices(payload: unknown): UnknownRecord[] {
  const record = unwrapRecord(payload, 'profile', 'record', 'data') ?? asRecord(payload);
  return (asArray(record.sliceList) ?? []).filter(
    (entry): entry is UnknownRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );
}
