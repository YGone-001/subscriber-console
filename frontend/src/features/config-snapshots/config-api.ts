import { getJson } from '../../lib/api/read-client';
import { postJson, putJson } from '../../lib/api/mutation-client';

export type Snapshot = {
  snapshotId: string; sourceId: string; generation: string; collectorId: string; resourceId: string;
  collectedAt: string; actor: string; mode: string; reason: string; policy: string;
  projectionHash: string; projection: string; size: number;
};
export type Observation = {
  observationId: string; sourceId: string; generation: string; resourceId: string;
  collectedAt: string; actor: string; status: string; reason: string; snapshotId: string; changed: boolean | null;
};
export type ConfigSource = {
  sourceId: string; name: string; collectorId: string; resourceId: string; format: string;
  profile: string; generation: string; intervalSeconds: number; registered: boolean; revision: number;
  collectionState: string; resourceState: string; latest: Observation | null; latestSnapshot: Snapshot | null;
  baselineId: string; baselineBy: string; baselineAt: string | null; comparison: string; pending: boolean;
  nextCollectionAt: string | null; scheduleState: string; scheduleLastError: string;
};
export type ConfigMeta = { catalogState: string; fingerprintConfigured: boolean; workerState: string; retentionDays: number; maxVersions: number; remoteCollectionSupported: false };
export type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
export type SourceList = Page<ConfigSource> & { summary: Record<string, number> | null; completeness: string; catalogState: string };
export type ConfigDiff = { left: Snapshot; right: Snapshot; comparison: string; complete: boolean; reason: string; lines: { kind: 'same' | 'add' | 'remove'; left: number | null; right: number | null; text: string }[] };

export function sourcePath(id: string) { return `/api/config-snapshots/sources/${encodeURIComponent(id)}`; }
export function captureRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const readConfig = <T,>(path: string) => getJson<T>(path);
export function captureConfig(id: string, requestId: string) { return postJson<Observation>(`${sourcePath(id)}/captures`, { requestId }); }
export function setConfigBaseline(id: string, expectedRevision: number, snapshotId: string) { return putJson<ConfigSource>(`${sourcePath(id)}/baseline`, { expectedRevision, snapshotId }); }
export function sourceListPath(params: URLSearchParams) {
  const q = new URLSearchParams({ limit: '50' });
  for (const key of ['q', 'cursor', 'resourceId', 'status']) { const value = params.get(key); if (value) q.set(key, value); }
  return `/api/config-snapshots/sources?${q}`;
}
