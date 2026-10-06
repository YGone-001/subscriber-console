/*
 * The single frontend owner of the two data-consistency remediation endpoints.
 *
 * These operations are NOT the retired user-facing audit console. The authoritative
 * operation model (`docs/operations/direct-operation-model.md`) defines
 * `/api/system/audit/*` as direct data-consistency diagnosis and repair: the Go
 * router registers both routes, and each one enforces authentication, the
 * `system_heal` capability, its own rate limit (20/60s single, 10/60s batch) and
 * operation logging before executing.
 *
 * Because they execute directly, the request has already been applied when it
 * resolves: there is no pending-review state to display. The server remains the
 * final authority on authorisation; the UI only decides whether to offer the action.
 *
 * Nothing else in the frontend may call these paths. `disabled-operations.test.ts`
 * asserts that ownership.
 */
import { postJson } from '../../lib/api/mutation-client';
import { buildBatchHealRequest, buildSingleHealRequest } from './operational-contract';
import type { BatchHealResponse, SingleHealResponse } from './operational-types';
import type { SystemAnomaly } from '../../types/platformHealth';

/** Owned by this module only. */
export const SINGLE_HEAL_PATH = '/api/system/audit/heal';
/** Owned by this module only. */
export const BATCH_HEAL_PATH = '/api/system/audit/batch-heal';
/** Consistency scan cursor step. Owned by this module only. */
export const AUDIT_SCAN_PATH = '/api/system/audit/scan';
/** Telemetry re-sync trigger. Owned by this module only. */
export const ANALYTICS_SYNC_PATH = '/api/analytics/init';

/** How a batch run should be reported to the operator. */
export type BatchHealOutcome = 'succeeded' | 'partial' | 'failed';

/**
 * A batch run is only "succeeded" when nothing failed. A run that repaired some
 * targets and failed others is "partial" and must be surfaced as such — reporting it
 * as success is exactly the kind of silent failure this mapping prevents.
 */
export function classifyBatchHealOutcome(response: BatchHealResponse): BatchHealOutcome {
  const succeeded = Number(response?.successCount ?? 0);
  const failed = Number(response?.failedCount ?? 0);
  if (failed === 0) return 'succeeded';
  if (succeeded > 0) return 'partial';
  return 'failed';
}

/** Per-target failure detail, kept verbatim so the operator sees the server's reason. */
export function batchHealErrors(response: BatchHealResponse): string[] {
  return Array.isArray(response?.errors) ? response.errors.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : [];
}

/**
 * Repairs one anomaly.
 *
 * Transport failures (401, 403, 429, network) are raised by the mutation client with
 * its own error contract and are never retried automatically.
 */
export async function requestSingleHeal(
  anomaly: unknown,
  profileName?: string,
): Promise<SingleHealResponse> {
  const payload = buildSingleHealRequest(anomaly, profileName);
  return postJson<SingleHealResponse>(SINGLE_HEAL_PATH, payload);
}

/** Repairs a set of anomalies in one server-side batch. */
export async function requestBatchHeal(
  anomalies: unknown,
  profileName?: string,
): Promise<BatchHealResponse> {
  const payload = buildBatchHealRequest(anomalies, profileName);
  return postJson<BatchHealResponse>(BATCH_HEAL_PATH, payload);
}

/** Response of one consistency-scan cursor step. */
export interface AuditScanStep {
  scannedCount: number;
  anomalies?: SystemAnomaly[];
  nextCursor: number | string;
}

/** Runs one cursor step of the data-consistency scan. */
export async function requestAuditScanStep(cursor: string, phase: string): Promise<AuditScanStep> {
  return postJson<AuditScanStep>(AUDIT_SCAN_PATH, { cursor, phase });
}

/** Triggers a telemetry re-sync. */
export async function requestAnalyticsSync(): Promise<unknown> {
  return postJson(ANALYTICS_SYNC_PATH);
}
