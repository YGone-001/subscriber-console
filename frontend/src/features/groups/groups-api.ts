import { getJson } from '../../lib/api/read-client';
import { groupSearch, type GroupFilter, type GroupPage, type GroupEntry, type GroupSummary } from './groups-model';

export function fetchGroupDirectory(params: Record<string, string | undefined>): Promise<GroupPage<GroupEntry>> {
  return getJson(`/api/operations/groups?${groupSearch(params)}`);
}
export function fetchGroupSummary(filter: GroupFilter): Promise<GroupSummary> {
  return getJson(`/api/operations/groups/summary?${groupSearch(filter)}`);
}
export function fetchGroupMembers<T>(params: Record<string, string | undefined>): Promise<GroupPage<T>> {
  return getJson(`/api/operations/groups/members?${groupSearch(params)}`);
}
