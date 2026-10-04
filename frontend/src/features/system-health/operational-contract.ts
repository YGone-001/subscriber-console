import type {
  AuditScanRequest,
  BatchHealAnomaly,
  BatchHealRequest,
  ScanAuditPhase,
  SingleHealRequest,
} from './operational-types';

export const ALLOWED_SCAN_PHASES: readonly ScanAuditPhase[] = [
  'sub',
  'ocs',
  'tariff',
  'reservation',
] as const;

export function buildAnalyticsInitRequest(): Record<string, never> {
  return {};
}

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
      `Invalid audit scan phase: "${String(phase)}". Allowed phases: ${ALLOWED_SCAN_PHASES.join(', ')}.`,
    );
  }

  return {
    cursor: cursor.trim(),
    phase: phase as ScanAuditPhase,
  };
}

export function buildSingleHealRequest(
  anomaly: unknown,
  profileName?: string,
): SingleHealRequest {
  if (!anomaly || typeof anomaly !== 'object') {
    throw new Error('Single heal anomaly must be an object.');
  }

  const record = anomaly as Record<string, unknown>;
  const imsi = typeof record.imsi === 'string' ? record.imsi.trim() : '';
  const type = typeof record.type === 'string' ? record.type.trim() : '';

  if (!imsi) {
    throw new Error('Single heal anomaly must include a non-empty imsi.');
  }

  if (!type) {
    throw new Error('Single heal anomaly must include a non-empty type.');
  }

  const payload: SingleHealRequest = {
    imsi,
    type,
  };

  if (typeof profileName === 'string' && profileName.trim() !== '') {
    payload.profileName = profileName.trim();
  }

  return payload;
}

export function buildBatchHealRequest(
  anomalies: unknown,
  profileName?: string,
): BatchHealRequest {
  if (!Array.isArray(anomalies) || anomalies.length === 0) {
    throw new Error('Batch heal anomalies list is required and cannot be empty.');
  }

  const validatedAnomalies: BatchHealAnomaly[] = [];

  for (let index = 0; index < anomalies.length; index += 1) {
    const item = anomalies[index];
    if (!item || typeof item !== 'object') {
      throw new Error(`Batch heal anomaly at index ${index} must be an object.`);
    }

    const record = item as Record<string, unknown>;
    const imsi = typeof record.imsi === 'string' ? record.imsi.trim() : '';
    const type = typeof record.type === 'string' ? record.type.trim() : '';

    if (!imsi) {
      throw new Error(`Batch heal anomaly at index ${index} must include a non-empty imsi.`);
    }

    if (!type) {
      throw new Error(`Batch heal anomaly at index ${index} must include a non-empty type.`);
    }

    validatedAnomalies.push({
      imsi,
      type,
    });
  }

  const payload: BatchHealRequest = {
    anomalies: validatedAnomalies,
  };

  if (typeof profileName === 'string' && profileName.trim() !== '') {
    payload.profileName = profileName.trim();
  }

  return payload;
}
