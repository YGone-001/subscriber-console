/**
 * Frontend-facing platform health and diagnostic shapes returned by the
 * Go production API (`/api/system/health`, `/api/system/audit/*`).
 *
 * These declarations were relocated out of the removed Next.js business backend
 * (`frontend/src/server/repositories/systemHealthRepository.ts` and
 * `systemAuditRepository.ts`) so diagnostics UI keeps a typed view of Go responses.
 */

export type SubsystemStatus = 'healthy' | 'degraded' | 'critical';

export type CollectionHealth = {
  database: string;
  name: string;
  exists: boolean;
  documentCount: number | null;
  missingIndexes: string[];
};

export type MongoHealthReport = {
  ok: boolean;
  database: string;
  databases: {
    xcloud: string;
    app: string;
  };
  checkedAt: string;
  latencyMs: number;
  collections: CollectionHealth[];
  missingCollections: string[];
  missingIndexes: Array<{ collection: string; index: string }>;
};

export type DatabaseSubsystemHealth = {
  status: SubsystemStatus;
  latencyMs: number;
  xcloudDb: string;
  appDb: string;
  ready: boolean;
  totalCollections: number;
  existingCollections: number;
  missingCollectionsCount: number;
  missingIndexesCount: number;
  report: MongoHealthReport;
};

export type OcsSubsystemHealth = {
  status: SubsystemStatus;
  totalSubscribers: number;
  totalAllocatedOctets: number;
  totalUsedOctets: number;
  totalReservedOctets: number;
  totalAvailableOctets: number;
  utilizationRate: number;
  invariantsOk: boolean;
  brokenInvariantsCount: number;
  activeSessions: number;
  closingSessions: number;
  activeReservations: number;
  orphanedReservations: number;
  activeTariffPlans: number;
};

export type HssSubsystemHealth = {
  status: SubsystemStatus;
  totalSubscribers: number;
  validCredentialsCount: number;
  missingCredentialsCount: number;
  validSlicesCount: number;
  missingSlicesCount: number;
  activeProfilesCount: number;
  danglingProfilesCount: number;
};

export type SecuritySubsystemHealth = {
  status: SubsystemStatus;
  rootUserConfigured: boolean;
  activeUsersCount: number;
  unacknowledgedAlertsCount: number;
  criticalAlertsCount: number;
  warningAlertsCount: number;
  recentAuditLogsCount: number;
};

export type ComprehensiveSystemHealth = {
  status: SubsystemStatus;
  score: number;
  checkedAt: string;
  subsystems: {
    database: DatabaseSubsystemHealth;
    ocsEngine: OcsSubsystemHealth;
    hssCore: HssSubsystemHealth;
    security: SecuritySubsystemHealth;
  };
  summary: {
    totalAnomaliesDetected: number;
    actionableItemsCount: number;
    recommendations: string[];
  };
};

export type AnomalyType =
  | 'missing_config'
  | 'balance_mismatch'
  | 'orphan_ocs'
  | 'orphan_reservation'
  | 'invalid_tariff'
  | 'dangling_profile';

export type AnomalyCategory = 'hss' | 'ocs' | 'reservation' | 'tariff' | 'profile';
export type AnomalySeverity = 'critical' | 'warning' | 'info';

export type SystemAnomaly = {
  imsi: string;
  type: AnomalyType;
  details: string;
  severity: AnomalySeverity;
  category: AnomalyCategory;
};
