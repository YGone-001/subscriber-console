import { Document, Long } from 'mongodb';
import { getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import { buildDefaultOpen5gsSubscriber } from '@/lib/xcloudSubscriber';
import { DEFAULT_OCS_PLAN_ID, provisionOcsSubscriber } from '@/server/repositories/ocsBillingRepository';
import { getProfile, listProfiles } from '@/server/repositories/profileRepository';
import type { Open5gsSubscriberDocument } from '@/types/xcloud';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

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

export type ScanPhase = 'sub' | 'ocs' | 'tariff' | 'reservation';

function subscribersCollection() {
  return getOpen5gsCollection<SubscriberDoc>(mongoCollections.subscribers);
}

function ocsSubscribersCollection() {
  return getOpen5gsCollection<Document & { imsi: string; plan_id?: string }>(mongoCollections.ocsSubscribers);
}

function ocsBalancesCollection() {
  return getOpen5gsCollection<Document & {
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

function ocsReservationsCollection() {
  return getOpen5gsCollection<Document & {
    reservation_id: string;
    session_id: string;
    imsi: string;
    state?: string;
    reserved_octets?: Long | number;
  }>(mongoCollections.ocsReservations);
}

function ocsSessionsCollection() {
  return getOpen5gsCollection<Document & { session_id: string; state?: string }>(mongoCollections.ocsSessions);
}

function tariffPlansCollection() {
  return getOpen5gsCollection<Document & { plan_id: string }>(mongoCollections.ocsTariffPlans);
}

function pageOffset(cursor: unknown): number {
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function numericValue(value: unknown): number {
  if (Long.isLong(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function scanSubscriberDocuments(cursor: unknown, phase: unknown = 'sub') {
  const offset = pageOffset(cursor);
  const limit = 1000;
  const docs = await subscribersCollection();
  const anomalies: SystemAnomaly[] = [];

  // Phase: Reservations Scan
  if (phase === 'reservation') {
    const resColl = await ocsReservationsCollection();
    const sessColl = await ocsSessionsCollection();
    const reservations = await resColl.find({}).skip(offset).limit(limit).toArray();
    
    if (reservations.length > 0) {
      const sessionIds = reservations.map((r) => r.session_id).filter(Boolean);
      const activeSessions = await sessColl.find({ session_id: { $in: sessionIds } }).toArray();
      const activeSessionIds = new Set(activeSessions.map((s) => s.session_id));

      for (const res of reservations) {
        if (!res.session_id || !activeSessionIds.has(res.session_id) || res.state === 'orphaned') {
          anomalies.push({
            imsi: res.imsi || 'UNKNOWN',
            type: 'orphan_reservation',
            details: `Orphaned quota reservation [${res.reservation_id || 'unknown'}] with missing active session`,
            severity: 'warning',
            category: 'reservation',
          });
        }
      }
    }

    return {
      nextCursor: reservations.length === limit ? String(offset + reservations.length) : '0',
      scannedCount: reservations.length,
      anomalies,
    };
  }

  // Phase: Tariff Matrix Consistency Scan
  if (phase === 'tariff') {
    const ocsSubColl = await ocsSubscribersCollection();
    const tariffPlans = await tariffPlansCollection();
    const ocsSubs = await ocsSubColl.find({}).skip(offset).limit(limit).toArray();
    const allPlans = await tariffPlans.find({}).toArray();
    const planIdSet = new Set(allPlans.map((p) => p.plan_id));

    for (const sub of ocsSubs) {
      const planId = sub.plan_id;
      if (!planId || !planIdSet.has(planId)) {
        anomalies.push({
          imsi: sub.imsi,
          type: 'invalid_tariff',
          details: `Subscriber assigned to invalid or missing tariff plan: ${planId || 'none'}`,
          severity: 'warning',
          category: 'tariff',
        });
      }
    }

    return {
      nextCursor: ocsSubs.length === limit ? String(offset + ocsSubs.length) : '0',
      scannedCount: ocsSubs.length,
      anomalies,
    };
  }

  // Phase: OCS Balance & Session Invariants Scan
  if (phase === 'ocs') {
    const rows = await docs
      .find({}, { projection: { imsi: 1 } })
      .sort({ imsi: 1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    const imsis = rows.map((row) => row.imsi);
    const [ocsSubscribers, balances] = await Promise.all([
      (await ocsSubscribersCollection()).find({ imsi: { $in: imsis } }).toArray(),
      (await ocsBalancesCollection()).find({ imsi: { $in: imsis } }).toArray(),
    ]);
    const ocsByImsi = new Map(ocsSubscribers.map((row) => [row.imsi, row]));
    const balanceByImsi = new Map(balances.map((row) => [row.imsi, row]));
    const tariffPlans = await tariffPlansCollection();

    for (const row of rows) {
      const ocsSubscriber = ocsByImsi.get(row.imsi);
      const balance = balanceByImsi.get(row.imsi);

      if (!ocsSubscriber || !balance) {
        anomalies.push({
          imsi: row.imsi,
          type: 'missing_config',
          details: `Missing ${!ocsSubscriber ? 'ocs_subscribers' : ''}${!ocsSubscriber && !balance ? ' and ' : ''}${!balance ? 'ocs_balances' : ''}`,
          severity: 'critical',
          category: 'ocs',
        });
        continue;
      }

      const planId = ocsSubscriber.plan_id || DEFAULT_OCS_PLAN_ID;
      const plan = await tariffPlans.findOne({ plan_id: planId });
      if (!plan) {
        anomalies.push({
          imsi: row.imsi,
          type: 'invalid_tariff',
          details: `Missing tariff plan ${planId}`,
          severity: 'warning',
          category: 'tariff',
        });
        continue;
      }

      const total = numericValue(balance.data_total);
      const used = numericValue(balance.data_used);
      const reserved = numericValue(balance.data_reserved);
      const available = numericValue(balance.data_available);
      if (total !== used + reserved + available) {
        anomalies.push({
          imsi: row.imsi,
          type: 'balance_mismatch',
          details: `OCS data balance invariant mismatch: total (${total}) != used (${used}) + reserved (${reserved}) + available (${available})`,
          severity: 'critical',
          category: 'ocs',
        });
      }

      if (
        balance.voice_total === undefined ||
        balance.voice_used === undefined ||
        balance.voice_reserved === undefined ||
        balance.voice_available === undefined
      ) {
        anomalies.push({
          imsi: row.imsi,
          type: 'balance_mismatch',
          details: 'OCS voice balance fields missing',
          severity: 'warning',
          category: 'ocs',
        });
      } else {
        const voiceTotal = numericValue(balance.voice_total);
        const voiceUsed = numericValue(balance.voice_used);
        const voiceReserved = numericValue(balance.voice_reserved);
        const voiceAvailable = numericValue(balance.voice_available);
        if (voiceTotal !== voiceUsed + voiceReserved + voiceAvailable) {
          anomalies.push({
            imsi: row.imsi,
            type: 'balance_mismatch',
            details: 'OCS voice balance invariant mismatch',
            severity: 'critical',
            category: 'ocs',
          });
        }
      }

      if (
        balance.sms_total === undefined ||
        balance.sms_used === undefined ||
        balance.sms_available === undefined
      ) {
        anomalies.push({
          imsi: row.imsi,
          type: 'balance_mismatch',
          details: 'OCS SMS balance fields missing',
          severity: 'warning',
          category: 'ocs',
        });
      } else {
        const smsTotal = numericValue(balance.sms_total);
        const smsUsed = numericValue(balance.sms_used);
        const smsAvailable = numericValue(balance.sms_available);
        if (smsTotal !== smsUsed + smsAvailable) {
          anomalies.push({
            imsi: row.imsi,
            type: 'balance_mismatch',
            details: 'OCS SMS balance invariant mismatch',
            severity: 'critical',
            category: 'ocs',
          });
        }
      }
    }

    return {
      nextCursor: rows.length === limit ? String(offset + rows.length) : '0',
      scannedCount: rows.length,
      anomalies,
    };
  }

  // Phase: HSS / Core Subscriber Scan
  const rows = await docs
    .find({}, { projection: { imsi: 1, security: 1, slice: 1, ambr: 1, profile: 1, profile_name: 1, 'webui_meta.profile_name': 1 } })
    .sort({ imsi: 1 })
    .skip(offset)
    .limit(limit)
    .toArray();

  const existingProfiles = await listProfiles();
  const profileNameSet = new Set(existingProfiles.map((p) => p.name));

  for (const row of rows) {
    if (!row.security?.k || !row.security?.opc || !Array.isArray(row.slice) || row.slice.length === 0 || !row.ambr) {
      anomalies.push({
        imsi: row.imsi,
        type: 'missing_config',
        details: 'Missing HSS subscriber authentication or slice config',
        severity: 'critical',
        category: 'hss',
      });
    }

    const assignedProfile = row.webui_meta?.profile_name || row.profile_name || row.profile;
    if (assignedProfile && !profileNameSet.has(assignedProfile)) {
      anomalies.push({
        imsi: row.imsi,
        type: 'dangling_profile',
        details: `Subscriber references deleted or non-existent profile template: ${assignedProfile}`,
        severity: 'warning',
        category: 'profile',
      });
    }
  }

  return {
    nextCursor: rows.length === limit ? String(offset + rows.length) : '0',
    scannedCount: rows.length,
    anomalies,
  };
}

export async function healSubscriberDocument(imsi: string, type: string, profileName?: string) {
  const docs = await subscribersCollection();
  const existing = await docs.findOne({ imsi });
  const profile = profileName ? await getProfile(profileName) : null;

  if (type === 'orphan_ocs' || !existing) {
    const doc = buildDefaultOpen5gsSubscriber(imsi, profile || undefined);
    await docs.updateOne({ imsi }, { $setOnInsert: doc }, { upsert: true });
  }

  if (type === 'missing_config' || type === 'balance_mismatch') {
    const total = Number(profile?.ocsDefaults?.trafficTotal ?? profile?.ocsDefaults?.traffic_total ?? 10737418240);
    const available = Number(profile?.ocsDefaults?.trafficBalance ?? profile?.ocsDefaults?.traffic_balance ?? total);
    const smsTotal = Number(profile?.ocsDefaults?.smsTotal ?? profile?.ocsDefaults?.sms_total ?? 100);
    const smsAvailable = Number(profile?.ocsDefaults?.smsBalance ?? profile?.ocsDefaults?.sms_balance ?? smsTotal);
    const planId = profile?.ocsDefaults?.planId ?? profile?.ocsDefaults?.plan_id ?? DEFAULT_OCS_PLAN_ID;
    await provisionOcsSubscriber({ imsi, planId, total, available, smsTotal, smsAvailable });
  }

  if (type === 'invalid_tariff') {
    const ocsSubColl = await ocsSubscribersCollection();
    await ocsSubColl.updateOne(
      { imsi },
      { $set: { plan_id: DEFAULT_OCS_PLAN_ID, updated_at: new Date() } }
    );
  }

  if (type === 'dangling_profile') {
    const fallbackProfile = profileName || existingProfilesFallback();
    await docs.updateOne(
      { imsi },
      {
        $set: {
          'webui_meta.profile_name': fallbackProfile,
          profile_name: fallbackProfile,
          profile: fallbackProfile,
          updated_at: new Date(),
        },
      }
    );
  }

  if (type === 'orphan_reservation') {
    const resColl = await ocsReservationsCollection();
    await resColl.updateMany(
      { imsi },
      { $set: { state: 'released', released_at: new Date() } }
    );
  }
}

function existingProfilesFallback(): string {
  return 'default';
}

export async function batchHealSubscriberDocuments(
  anomalies: Array<{ imsi: string; type: string }>,
  profileName?: string
): Promise<{ successCount: number; failedCount: number; errors: string[] }> {
  let successCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  for (const item of anomalies) {
    try {
      await healSubscriberDocument(item.imsi, item.type, profileName);
      successCount++;
    } catch (err) {
      failedCount++;
      errors.push(`Failed to heal ${item.imsi} (${item.type}): ${String(err)}`);
    }
  }

  return { successCount, failedCount, errors };
}
