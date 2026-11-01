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
