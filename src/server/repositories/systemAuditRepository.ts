import { Document, Long } from 'mongodb';
import { getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import { buildDefaultOpen5gsSubscriber } from '@/lib/open5gsSubscriber';
import { provisionOcsSubscriber } from '@/server/repositories/ocsBillingRepository';
import { getProfile } from '@/server/repositories/profileRepository';
import type { Open5gsSubscriberDocument } from '@/types/open5gs';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

export type SystemAnomaly = {
  imsi: string;
  type: 'missing_config' | 'balance_mismatch' | 'orphan_ocs';
  details: string;
};

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
  }>(mongoCollections.ocsBalances);
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

export async function scanSubscriberDocuments(cursor: unknown, phase: unknown) {
  const offset = pageOffset(cursor);
  const limit = 1000;
  const docs = await subscribersCollection();
  const rows = await docs
    .find({}, { projection: { imsi: 1, security: 1, slice: 1, ambr: 1 } })
    .sort({ imsi: 1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  const anomalies: SystemAnomaly[] = [];

  if (phase === 'ocs') {
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
        });
        continue;
      }

      const planId = ocsSubscriber.plan_id || 'plan_default_10gb';
      const plan = await tariffPlans.findOne({ plan_id: planId });
      if (!plan) {
        anomalies.push({ imsi: row.imsi, type: 'missing_config', details: `Missing tariff plan ${planId}` });
        continue;
      }

      const total = numericValue(balance.data_total);
      const used = numericValue(balance.data_used);
      const reserved = numericValue(balance.data_reserved);
      const available = numericValue(balance.data_available);
      if (total !== used + reserved + available) {
        anomalies.push({ imsi: row.imsi, type: 'balance_mismatch', details: 'OCS balance invariant mismatch' });
      }
    }

    return {
      nextCursor: rows.length === limit ? String(offset + rows.length) : '0',
      scannedCount: rows.length,
      anomalies,
    };
  }

  for (const row of rows) {
    if (!row.security?.k || !row.security?.opc || !Array.isArray(row.slice) || row.slice.length === 0 || !row.ambr) {
      anomalies.push({ imsi: row.imsi, type: 'missing_config', details: 'Missing HSS subscriber authentication or slice config' });
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
    await provisionOcsSubscriber({ imsi, total, available });
  }
}
