import { Long } from 'mongodb';
import { getAppDb, getOpen5gsDb, mongoCollections, mongoDbNames } from '@/lib/mongo';
import { getMongoHealthReport, MongoHealthReport } from './mongoHealthRepository';

export type SubsystemStatus = 'healthy' | 'degraded' | 'critical';

export type DatabaseSubsystemHealth = {
  status: SubsystemStatus;
  latencyMs: number;
  open5gsDb: string;
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
  pendingApprovalsCount: number;
  unacknowledgedAlertsCount: number;
  criticalAlertsCount: number;
  warningAlertsCount: number;
  recentAuditLogsCount: number;
};

export type ComprehensiveSystemHealth = {
  status: SubsystemStatus;
  score: number; // 0 - 100
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

function numericValue(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (Long.isLong(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function getComprehensiveSystemHealth(): Promise<ComprehensiveSystemHealth> {
  const [open5gsDb, appDb] = await Promise.all([getOpen5gsDb(), getAppDb()]);
  const databases = mongoDbNames();

  // 1. Run Mongo Health Check
  const mongoReport = await getMongoHealthReport();

  // 2. Fetch OCS Health Telemetry concurrently
  const [
    balanceAgg,
    balanceSamples,
    sessionAgg,
    reservationAgg,
    tariffPlanCount,
    hssSubscribers,
    profileNames,
    usersCount,
    pendingApprovals,
    alertsAgg,
    auditLogCount,
  ] = await Promise.all([
    // Balance aggregation
    open5gsDb.collection(mongoCollections.ocsBalances).aggregate<{
      totalSubscribers: number;
      totalAllocated: number;
      totalUsed: number;
      totalReserved: number;
      totalAvailable: number;
    }>([
      {
        $group: {
          _id: null,
          totalSubscribers: { $sum: 1 },
          totalAllocated: { $sum: { $ifNull: ['$data_total', 0] } },
          totalUsed: { $sum: { $ifNull: ['$data_used', 0] } },
          totalReserved: { $sum: { $ifNull: ['$data_reserved', 0] } },
          totalAvailable: { $sum: { $ifNull: ['$data_available', 0] } },
        },
      },
    ]).toArray(),

    // Sample balances for invariant validation
    open5gsDb.collection(mongoCollections.ocsBalances).find({}).limit(500).toArray(),

    // Sessions aggregation
    open5gsDb.collection(mongoCollections.ocsSessions).aggregate<{
      active: number;
      closing: number;
    }>([
      {
        $group: {
          _id: null,
          active: { $sum: { $cond: [{ $eq: ['$state', 'active'] }, 1, 0] } },
          closing: { $sum: { $cond: [{ $eq: ['$state', 'closing'] }, 1, 0] } },
        },
      },
    ]).toArray(),

    // Reservations aggregation
    open5gsDb.collection(mongoCollections.ocsReservations).aggregate<{
      active: number;
      orphaned: number;
      totalReservedOctets: number;
    }>([
      {
        $group: {
          _id: null,
          active: { $sum: { $cond: [{ $eq: ['$state', 'active'] }, 1, 0] } },
          orphaned: { $sum: { $cond: [{ $eq: ['$state', 'orphaned'] }, 1, 0] } },
          totalReservedOctets: { $sum: { $ifNull: ['$reserved_octets', 0] } },
        },
      },
    ]).toArray(),

    // Tariff plans count
    open5gsDb.collection(mongoCollections.ocsTariffPlans).countDocuments({}),

    // HSS Core subscriber sample & count
    open5gsDb.collection(mongoCollections.subscribers).find({}, {
      projection: { imsi: 1, security: 1, slice: 1, profile: 1, profile_name: 1, 'webui_meta.profile_name': 1 }
    }).limit(1000).toArray(),

    // Active profiles
    appDb.collection(mongoCollections.profiles).find({}, { projection: { name: 1 } }).toArray(),

    // App users count
    appDb.collection(mongoCollections.users).countDocuments({}),

    // Pending approvals count
    appDb.collection(mongoCollections.approvals).countDocuments({ status: 'PENDING' }),

    // Active Alerts aggregation
    appDb.collection(mongoCollections.alerts).aggregate<{
      unacknowledged: number;
      critical: number;
      warning: number;
    }>([
      {
        $group: {
          _id: null,
          unacknowledged: { $sum: { $cond: [{ $eq: ['$is_acknowledged', false] }, 1, 0] } },
          critical: { $sum: { $cond: [{ $and: [{ $eq: ['$is_acknowledged', false] }, { $eq: ['$level', 'CRITICAL'] }] }, 1, 0] } },
          warning: { $sum: { $cond: [{ $and: [{ $eq: ['$is_acknowledged', false] }, { $eq: ['$level', 'WARNING'] }] }, 1, 0] } },
        },
      },
    ]).toArray(),

    // Recent audit logs count (last 24h)
    appDb.collection(mongoCollections.auditLogs).countDocuments({
      timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }
    }),
  ]);

  // Balance Invariant Check
  let brokenInvariantsCount = 0;
  for (const b of balanceSamples) {
    const tot = numericValue(b.data_total);
    const used = numericValue(b.data_used);
    const res = numericValue(b.data_reserved);
    const avail = numericValue(b.data_available);
    if (tot !== (used + res + avail)) {
      brokenInvariantsCount++;
    }
  }

  // Database Subsystem evaluation
  const dbMissingCollections = mongoReport.missingCollections.length;
  const dbMissingIndexes = mongoReport.missingIndexes.length;
  const dbStatus: SubsystemStatus = (!mongoReport.ok || dbMissingCollections > 0 || dbMissingIndexes > 0)
    ? (dbMissingCollections > 0 ? 'critical' : 'degraded')
    : 'healthy';

  const databaseSubsystem: DatabaseSubsystemHealth = {
    status: dbStatus,
    latencyMs: mongoReport.latencyMs,
    open5gsDb: databases.open5gs,
    appDb: databases.app,
    ready: mongoReport.ok,
    totalCollections: mongoReport.collections.length,
    existingCollections: mongoReport.collections.filter((c) => c.exists).length,
    missingCollectionsCount: dbMissingCollections,
    missingIndexesCount: dbMissingIndexes,
    report: mongoReport,
  };

  // OCS Subsystem evaluation
  const bData = balanceAgg[0] || {
    totalSubscribers: 0,
    totalAllocated: 0,
    totalUsed: 0,
    totalReserved: 0,
    totalAvailable: 0,
  };
  const sData = sessionAgg[0] || { active: 0, closing: 0 };
  const rData = reservationAgg[0] || { active: 0, orphaned: 0, totalReservedOctets: 0 };

  const totalAllocated = numericValue(bData.totalAllocated);
  const totalUsed = numericValue(bData.totalUsed);
  const utilizationRate = totalAllocated > 0 ? Number(((totalUsed / totalAllocated) * 100).toFixed(2)) : 0;
  const orphanedReservations = rData.orphaned;

  const ocsStatus: SubsystemStatus = (brokenInvariantsCount > 0 || tariffPlanCount === 0)
    ? 'critical'
    : (orphanedReservations > 0 || utilizationRate > 90)
    ? 'degraded'
    : 'healthy';

  const ocsSubsystem: OcsSubsystemHealth = {
    status: ocsStatus,
    totalSubscribers: numericValue(bData.totalSubscribers),
    totalAllocatedOctets: totalAllocated,
    totalUsedOctets: totalUsed,
    totalReservedOctets: numericValue(rData.totalReservedOctets),
    totalAvailableOctets: numericValue(bData.totalAvailable),
    utilizationRate,
    invariantsOk: brokenInvariantsCount === 0,
    brokenInvariantsCount,
    activeSessions: sData.active,
    closingSessions: sData.closing,
    activeReservations: rData.active,
    orphanedReservations,
    activeTariffPlans: tariffPlanCount,
  };

  // HSS Subsystem evaluation
  const activeProfileSet = new Set(profileNames.map((p) => p.name));
  let missingCredentialsCount = 0;
  let missingSlicesCount = 0;
  let danglingProfilesCount = 0;

  for (const sub of hssSubscribers) {
    if (!sub.security?.k || !sub.security?.opc) {
      missingCredentialsCount++;
    }
    if (!Array.isArray(sub.slice) || sub.slice.length === 0) {
      missingSlicesCount++;
    }
    const profName = sub.webui_meta?.profile_name || sub.profile_name || sub.profile;
    if (profName && !activeProfileSet.has(profName)) {
      danglingProfilesCount++;
    }
  }

  const hssStatus: SubsystemStatus = (missingCredentialsCount > 0 || missingSlicesCount > 0)
    ? 'critical'
    : danglingProfilesCount > 0
    ? 'degraded'
    : 'healthy';

  const hssSubsystem: HssSubsystemHealth = {
    status: hssStatus,
    totalSubscribers: hssSubscribers.length,
    validCredentialsCount: Math.max(0, hssSubscribers.length - missingCredentialsCount),
    missingCredentialsCount,
    validSlicesCount: Math.max(0, hssSubscribers.length - missingSlicesCount),
    missingSlicesCount,
    activeProfilesCount: profileNames.length,
    danglingProfilesCount,
  };

  // Security Subsystem evaluation
  const alertStats = alertsAgg[0] || { unacknowledged: 0, critical: 0, warning: 0 };
  const rootUserConfigured = usersCount > 0;
  const criticalAlerts = alertStats.critical;
  const warningAlerts = alertStats.warning;

  const securityStatus: SubsystemStatus = (!rootUserConfigured || criticalAlerts > 0)
    ? 'critical'
    : (warningAlerts > 0 || pendingApprovals > 5)
    ? 'degraded'
    : 'healthy';

  const securitySubsystem: SecuritySubsystemHealth = {
    status: securityStatus,
    rootUserConfigured,
    activeUsersCount: usersCount,
    pendingApprovalsCount: pendingApprovals,
    unacknowledgedAlertsCount: alertStats.unacknowledged,
    criticalAlertsCount: criticalAlerts,
    warningAlertsCount: warningAlerts,
    recentAuditLogsCount: auditLogCount,
  };

  // Recommendations & actionable items
  const recommendations: string[] = [];
  let actionableItemsCount = 0;

  if (dbMissingCollections > 0 || dbMissingIndexes > 0) {
    recommendations.push(`Run MongoDB index initialization (npm run mongo:init) to restore ${dbMissingIndexes} missing indexes`);
    actionableItemsCount++;
  }
  if (brokenInvariantsCount > 0) {
    recommendations.push(`Resolve ${brokenInvariantsCount} OCS balance invariant inconsistencies`);
    actionableItemsCount++;
  }
  if (orphanedReservations > 0) {
    recommendations.push(`Clean up ${orphanedReservations} orphaned in-flight quota reservations`);
    actionableItemsCount++;
  }
  if (missingCredentialsCount > 0 || missingSlicesCount > 0) {
    recommendations.push(`Fix ${missingCredentialsCount + missingSlicesCount} malformed HSS subscriber records`);
    actionableItemsCount++;
  }
  if (danglingProfilesCount > 0) {
    recommendations.push(`Rebind ${danglingProfilesCount} subscribers referencing missing profile templates`);
    actionableItemsCount++;
  }
  if (criticalAlerts > 0) {
    recommendations.push(`Acknowledge and triage ${criticalAlerts} critical operational alerts in NOC`);
    actionableItemsCount++;
  }

  // Calculate composite score
  let score = 100;
  if (dbStatus === 'critical') score -= 35;
  else if (dbStatus === 'degraded') score -= 15;

  if (ocsStatus === 'critical') score -= 25;
  else if (ocsStatus === 'degraded') score -= 10;

  if (hssStatus === 'critical') score -= 20;
  else if (hssStatus === 'degraded') score -= 8;

  if (securityStatus === 'critical') score -= 20;
  else if (securityStatus === 'degraded') score -= 10;

  score = Math.max(0, Math.min(100, score));

  const overallStatus: SubsystemStatus = (score >= 90 && dbStatus === 'healthy' && ocsStatus === 'healthy')
    ? 'healthy'
    : score < 70 || dbStatus === 'critical' || ocsStatus === 'critical'
    ? 'critical'
    : 'degraded';

  const totalAnomaliesDetected = brokenInvariantsCount + orphanedReservations + missingCredentialsCount + missingSlicesCount + danglingProfilesCount + criticalAlerts;

  return {
    status: overallStatus,
    score,
    checkedAt: new Date().toISOString(),
    subsystems: {
      database: databaseSubsystem,
      ocsEngine: ocsSubsystem,
      hssCore: hssSubsystem,
      security: securitySubsystem,
    },
    summary: {
      totalAnomaliesDetected,
      actionableItemsCount,
      recommendations,
    },
  };
}
