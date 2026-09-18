import { Document, Long } from 'mongodb';
import { getXcloudCollection, mongoCollections } from '@/lib/mongo';
import { DEFAULT_OCS_PLAN_ID, firstActiveRatingPolicy } from '@/server/repositories/ocsBillingRepository';
import type { XcloudSubscriberDocument } from '@/types/xcloud';

type SubscriberDoc = XcloudSubscriberDocument & Document;

export type OcsBalanceMetrics = {
  totalSubscribers: number;
  totalDataAllocated: number;
  totalDataUsed: number;
  totalDataReserved: number;
  totalDataAvailable: number;
  dataUtilizationRate: number;
  totalVoiceAllocated: number;
  totalVoiceUsed: number;
  totalVoiceReserved: number;
  totalVoiceAvailable: number;
  totalSmsAllocated: number;
  totalSmsUsed: number;
  totalSmsAvailable: number;
  validInvariantCount: number;
  brokenInvariantCount: number;
  allInvariantsOk: boolean;
};

export type OcsSessionMetrics = {
  totalSessions: number;
  activeSessions: number;
  closingSessions: number;
  closedSessions: number;
  totalGrantedOctets: number;
  totalUsedOctets: number;
  interfaceGyCount: number;
  interfaceRoCount: number;
  apnDistribution: Array<{ apn: string; count: number }>;
};

export type OcsReservationMetrics = {
  totalReservations: number;
  activeReservations: number;
  settledReservations: number;
  releasedReservations: number;
  orphanedReservations: number;
  totalReservedOctets: number;
  totalReleasedOctets: number;
  totalUsedOctets: number;
};

export type TariffPlanDistItem = {
  planId: string;
  name: string;
  subscriberCount: number;
  percentage: number;
  status: string;
};

export type OcsUsageMetrics = {
  totalRecords: number;
  chargedRecords: number;
  totalInputOctets: number;
  totalOutputOctets: number;
  totalOctets: number;
};

export type AnalyticsMetrics = {
  // Legacy / core fields for backward compatibility:
  totalTraffic: number;
  plmnDist: Array<{ name: string; value: number }>;
  ratesDist: Array<{ name: string; value: number }>;
  top5: Array<{ imsi: string; balance: number; voiceBalance: number; smsBalance: number }>;
  timestamp: number;

  // Rich OCS telemetry indicators:
  ocsBalances: OcsBalanceMetrics;
  ocsSessions: OcsSessionMetrics;
  ocsReservations: OcsReservationMetrics;
  tariffPlanDist: TariffPlanDistItem[];
  ocsUsage: OcsUsageMetrics;
};

function subscribersCollection() {
  return getXcloudCollection<SubscriberDoc>(mongoCollections.subscribers);
}

function balancesCollection() {
  return getXcloudCollection<Document & {
    imsi: string;
    data_total?: Long | number;
    data_used?: Long | number;
    data_reserved?: Long | number;
    data_available?: Long | number;
    voice_total?: Long | number;
    voice_used?: Long | number;
    voice_reserved?: Long | number;
    voice_available?: Long | number;
    sms_total?: Long | number;
    sms_used?: Long | number;
    sms_available?: Long | number;
  }>(mongoCollections.ocsBalances);
}

function sessionsCollection() {
  return getXcloudCollection(mongoCollections.ocsSessions);
}

function reservationsCollection() {
  return getXcloudCollection(mongoCollections.ocsReservations);
}

function usageRecordsCollection() {
  return getXcloudCollection(mongoCollections.ocsUsageRecords);
}

function ocsSubscribersCollection() {
  return getXcloudCollection(mongoCollections.ocsSubscribers);
}

function tariffPlansCollection() {
  return getXcloudCollection(mongoCollections.ocsTariffPlans);
}

function numericValue(value: unknown, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (Long.isLong(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function computeAnalyticsMetrics(): Promise<AnalyticsMetrics> {
  const [
    balanceColl,
    sessionColl,
    reservationColl,
    usageColl,
    ocsSubColl,
    planColl,
    policy,
  ] = await Promise.all([
    balancesCollection(),
    sessionsCollection(),
    reservationsCollection(),
    usageRecordsCollection(),
    ocsSubscribersCollection(),
    tariffPlansCollection(),
    firstActiveRatingPolicy(),
  ]);

  // 1. OCS Balances Aggregation
  const [balanceAgg, top5Docs, plmnAgg] = await Promise.all([
    balanceColl.aggregate([
      {
        $group: {
          _id: null,
          totalSubscribers: { $sum: 1 },
          totalDataAllocated: { $sum: '$data_total' },
          totalDataUsed: { $sum: '$data_used' },
          totalDataReserved: { $sum: '$data_reserved' },
          totalDataAvailable: { $sum: '$data_available' },
          totalVoiceAllocated: { $sum: { $ifNull: ['$voice_total', 3600] } },
          totalVoiceUsed: { $sum: { $ifNull: ['$voice_used', 0] } },
          totalVoiceReserved: { $sum: { $ifNull: ['$voice_reserved', 0] } },
          totalVoiceAvailable: { $sum: { $ifNull: ['$voice_available', 3600] } },
          totalSmsAllocated: { $sum: { $ifNull: ['$sms_total', 100] } },
          totalSmsUsed: { $sum: { $ifNull: ['$sms_used', 0] } },
          totalSmsAvailable: { $sum: { $ifNull: ['$sms_available', 100] } },
        },
      },
    ]).toArray(),
    balanceColl
      .find({ data_available: { $gt: 0 } }, { projection: { imsi: 1, data_available: 1, voice_available: 1, sms_available: 1 } })
      .sort({ data_available: -1 })
      .limit(5)
      .toArray(),
    balanceColl.aggregate([
      { $match: { data_available: { $gt: 0 } } },
      {
        $project: {
          plmn: {
            $substrCP: [
              { $ifNull: ['$imsi', '45400'] },
              0,
              5,
            ],
          },
          data_available: 1,
        },
      },
      {
        $group: {
          _id: '$plmn',
          value: { $sum: '$data_available' },
        },
      },
      { $sort: { value: -1 } },
      { $limit: 10 },
    ]).toArray(),
  ]);

  // Balance Invariant Check (Sample or aggregation)
  const balanceRawDocs = await balanceColl.find({}).limit(500).toArray();
  let brokenInvariantCount = 0;
  for (const b of balanceRawDocs) {
    const dTot = numericValue(b.data_total);
    const dUsed = numericValue(b.data_used);
    const dRes = numericValue(b.data_reserved);
    const dAvail = numericValue(b.data_available);
    if (dTot !== (dUsed + dRes + dAvail)) {
      brokenInvariantCount++;
    }
  }

  const bSum = balanceAgg[0] || {};
  const totalSubscribers = numericValue(bSum.totalSubscribers);
  const totalDataAllocated = numericValue(bSum.totalDataAllocated);
  const totalDataUsed = numericValue(bSum.totalDataUsed);
  const totalDataReserved = numericValue(bSum.totalDataReserved);
  const totalDataAvailable = numericValue(bSum.totalDataAvailable);
  const dataUtilizationRate = totalDataAllocated > 0
    ? Number(((totalDataUsed / totalDataAllocated) * 100).toFixed(2))
    : 0;

  const ocsBalances: OcsBalanceMetrics = {
    totalSubscribers,
    totalDataAllocated,
    totalDataUsed,
    totalDataReserved,
    totalDataAvailable,
    dataUtilizationRate,
    totalVoiceAllocated: numericValue(bSum.totalVoiceAllocated),
    totalVoiceUsed: numericValue(bSum.totalVoiceUsed),
    totalVoiceReserved: numericValue(bSum.totalVoiceReserved),
    totalVoiceAvailable: numericValue(bSum.totalVoiceAvailable),
    totalSmsAllocated: numericValue(bSum.totalSmsAllocated),
    totalSmsUsed: numericValue(bSum.totalSmsUsed),
    totalSmsAvailable: numericValue(bSum.totalSmsAvailable),
    validInvariantCount: Math.max(0, totalSubscribers - brokenInvariantCount),
    brokenInvariantCount,
    allInvariantsOk: brokenInvariantCount === 0,
  };

  // 2. OCS Sessions Aggregation
  const [sessionAgg, apnAgg] = await Promise.all([
    sessionColl.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$state', 'active'] }, 1, 0] } },
          closing: { $sum: { $cond: [{ $eq: ['$state', 'closing'] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$state', 'closed'] }, 1, 0] } },
          granted: { $sum: '$granted_total' },
          used: { $sum: '$used_total' },
          gy: { $sum: { $cond: [{ $eq: ['$interface_type', 'gy'] }, 1, 0] } },
          ro: { $sum: { $cond: [{ $eq: ['$interface_type', 'ro'] }, 1, 0] } },
        },
      },
    ]).toArray(),
    sessionColl.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$apn', 'internet'] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]).toArray(),
  ]);

  const sSum = sessionAgg[0] || {};
  const apnMap = new Map<string, number>();
  for (const a of apnAgg) {
    const rawApn = typeof a._id === 'string' ? a._id.trim() : '';
    const apn = rawApn || 'internet';
    apnMap.set(apn, (apnMap.get(apn) || 0) + numericValue(a.count));
  }
  const apnDistribution = Array.from(apnMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([apn, count]) => ({ apn, count }));

  const ocsSessions: OcsSessionMetrics = {
    totalSessions: numericValue(sSum.total),
    activeSessions: numericValue(sSum.active),
    closingSessions: numericValue(sSum.closing),
    closedSessions: numericValue(sSum.closed),
    totalGrantedOctets: numericValue(sSum.granted),
    totalUsedOctets: numericValue(sSum.used),
    interfaceGyCount: numericValue(sSum.gy),
    interfaceRoCount: numericValue(sSum.ro),
    apnDistribution,
  };

  // 3. OCS Reservations Aggregation
  const reservationAgg = await reservationColl.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ['$state', 'active'] }, 1, 0] } },
        settled: { $sum: { $cond: [{ $eq: ['$state', 'settled'] }, 1, 0] } },
        released: { $sum: { $cond: [{ $eq: ['$state', 'released'] }, 1, 0] } },
        orphaned: { $sum: { $cond: [{ $eq: ['$state', 'orphaned'] }, 1, 0] } },
        totalReserved: { $sum: '$reserved_octets' },
        totalReleased: { $sum: '$released_octets' },
        totalUsed: { $sum: '$used_octets' },
      },
    },
  ]).toArray();

  const rSum = reservationAgg[0] || {};
  const ocsReservations: OcsReservationMetrics = {
    totalReservations: numericValue(rSum.total),
    activeReservations: numericValue(rSum.active),
    settledReservations: numericValue(rSum.settled),
    releasedReservations: numericValue(rSum.released),
    orphanedReservations: numericValue(rSum.orphaned),
    totalReservedOctets: numericValue(rSum.totalReserved),
    totalReleasedOctets: numericValue(rSum.totalReleased),
    totalUsedOctets: numericValue(rSum.totalUsed),
  };

  // 4. Tariff Plan Distribution
  const [subPlansAgg, allPlans] = await Promise.all([
    ocsSubColl.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$plan_id', DEFAULT_OCS_PLAN_ID] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]).toArray(),
    planColl.find({}).toArray(),
  ]);

  const planMap = new Map(allPlans.map((p) => [p.plan_id, p]));
  const totalSubscribersInPlans = subPlansAgg.reduce((acc, curr) => acc + numericValue(curr.count), 0);

  const tariffPlanDist: TariffPlanDistItem[] = subPlansAgg.map((item) => {
    const planId = String(item._id || DEFAULT_OCS_PLAN_ID);
    const count = numericValue(item.count);
    const planDoc = planMap.get(planId);
    const percentage = totalSubscribersInPlans > 0
      ? Number(((count / totalSubscribersInPlans) * 100).toFixed(1))
      : 0;

    return {
      planId,
      name: planDoc?.name || planId,
      subscriberCount: count,
      percentage,
      status: planDoc?.status || 'active',
    };
  });

  // If no subscriber in ocs_subscribers yet, list available tariff plans with 0 subscribers
  if (tariffPlanDist.length === 0 && allPlans.length > 0) {
    allPlans.forEach((plan) => {
      tariffPlanDist.push({
        planId: plan.plan_id,
        name: plan.name || plan.plan_id,
        subscriberCount: 0,
        percentage: 0,
        status: plan.status || 'active',
      });
    });
  }

  // 5. OCS Usage Records Aggregation
  const usageAgg = await usageColl.aggregate([
    {
      $group: {
        _id: null,
        totalRecords: { $sum: 1 },
        chargedRecords: { $sum: { $cond: [{ $eq: ['$charged', true] }, 1, 0] } },
        totalInputOctets: { $sum: '$input_octets' },
        totalOutputOctets: { $sum: '$output_octets' },
        totalOctets: { $sum: '$total_octets' },
      },
    },
  ]).toArray();

  const uSum = usageAgg[0] || {};
  const ocsUsage: OcsUsageMetrics = {
    totalRecords: numericValue(uSum.totalRecords),
    chargedRecords: numericValue(uSum.chargedRecords),
    totalInputOctets: numericValue(uSum.totalInputOctets),
    totalOutputOctets: numericValue(uSum.totalOutputOctets),
    totalOctets: numericValue(uSum.totalOctets),
  };

  // 6. Format top 5 and PLMN distribution
  const top5 = top5Docs.map((doc) => ({
    imsi: String(doc.imsi),
    balance: numericValue(doc.data_available),
    voiceBalance: numericValue(doc.voice_available),
    smsBalance: numericValue(doc.sms_available),
  }));

  const plmnDist = plmnAgg.map((item) => ({
    name: String(item._id),
    value: numericValue(item.value),
  }));

  const totalTraffic = totalDataAvailable;
  const ratesDist = policy
    ? [{ name: `Group #${policy.rating_group_id}`, value: totalSubscribers }]
    : [];

  return {
    totalTraffic,
    plmnDist,
    ratesDist,
    top5,
    timestamp: Date.now(),
    ocsBalances,
    ocsSessions,
    ocsReservations,
    tariffPlanDist,
    ocsUsage,
  };
}

export async function computeSparklineBasis() {
  const docs = await subscribersCollection();
  const [currentSubCount, metrics] = await Promise.all([
    docs.countDocuments({}),
    computeAnalyticsMetrics(),
  ]);

  return {
    currentSubCount,
    currentTraffic: metrics.totalTraffic,
  };
}
