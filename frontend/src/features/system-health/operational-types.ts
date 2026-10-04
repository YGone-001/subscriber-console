export type ScanPhase =
  | 'IDLE'
  | 'INIT'
  | 'SCAN_SUB'
  | 'SCAN_OCS'
  | 'SCAN_TARIFF'
  | 'SCAN_RESERVATIONS'
  | 'COMPLETE'
  | 'ABORTED';

export type ScanAuditPhase = 'sub' | 'ocs' | 'tariff' | 'reservation';

export interface SystemAnomaly {
  imsi: string;
  type: string;
  category?: string;
  severity?: string;
  details?: string;
  [key: string]: unknown;
}

export interface AuditScanRequest {
  cursor: string;
  phase: ScanAuditPhase;
}

export interface AuditScanResponse {
  nextCursor: string;
  scannedCount: number;
  anomalies?: SystemAnomaly[];
}

export interface AnalyticsInitResponse {
  message?: string;
  metrics?: Record<string, unknown>;
}

export interface SingleHealRequest {
  imsi: string;
  type: string;
  profileName?: string;
}

export interface SingleHealResponse {
  message?: string;
}

export interface BatchHealAnomaly {
  imsi: string;
  type: string;
}

export interface BatchHealRequest {
  anomalies: BatchHealAnomaly[];
  profileName?: string;
}

export interface BatchHealResponse {
  message?: string;
  successCount: number;
  failedCount: number;
  errors?: string[];
}
