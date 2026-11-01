/*
 * The single frontend owner of the read-only data-consistency scan.
 *
 * The former analytics-init and remediation owners are retired from the console:
 * analytics init computed a snapshot without writing anything, and remediation
 * fabricated default business data without a preview. The backend routes remain
 * registered for compatibility and for the CLI, but no SPA surface calls them.
 */
import { postJson } from '../../lib/api/mutation-client';
import { buildAuditScanRequest } from './operational-contract';
import type { SystemAnomaly } from '../../types/platformHealth';

/** Consistency scan cursor step. Owned by this module only. */
export const AUDIT_SCAN_PATH = '/api/system/audit/scan';

/** Response of one consistency-scan cursor step. */
export interface AuditScanStep {
  scannedCount: number;
  anomalies?: SystemAnomaly[];
  nextCursor: number | string;
}

/** Runs one cursor step of the data-consistency scan. */
export async function requestAuditScanStep(cursor: string, phase: string): Promise<AuditScanStep> {
  return postJson<AuditScanStep>(AUDIT_SCAN_PATH, buildAuditScanRequest(cursor, phase));
}
