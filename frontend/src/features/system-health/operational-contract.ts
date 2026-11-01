import type { AuditScanRequest, ScanAuditPhase } from './operational-types';

export const ALLOWED_SCAN_PHASES: readonly ScanAuditPhase[] = [
  'sub',
  'ocs',
  'tariff',
  'reservation',
] as const;

export function buildAuditScanRequest(
  cursor: unknown,
  phase: unknown,
): AuditScanRequest {
  if (typeof cursor !== 'string' || cursor.trim() === '') {
    throw new Error('Audit scan cursor must be a non-empty string.');
  }

  if (
    typeof phase !== 'string' ||
    !ALLOWED_SCAN_PHASES.includes(phase as ScanAuditPhase)
  ) {
    throw new Error(
      `Invalid audit scan phase: "${String(phase)}". Allowed phases: ${ALLOWED_SCAN_PHASES.join(', ')}`,
    );
  }

  return {
    cursor: cursor.trim(),
    phase: phase as ScanAuditPhase,
  };
}
