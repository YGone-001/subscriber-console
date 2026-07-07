import { Document } from 'mongodb';
import { getMongoCollection, mongoCollections } from '@/lib/mongo';
import { buildDefaultOpen5gsSubscriber } from '@/lib/open5gsSubscriber';
import { getProfile } from '@/server/repositories/profileRepository';
import type { Open5gsSubscriberDocument } from '@/types/open5gs';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

export type SystemAnomaly = {
  imsi: string;
  type: 'missing_config' | 'balance_mismatch' | 'orphan_ocs';
  details: string;
};

function collection() {
  return getMongoCollection<SubscriberDoc>(mongoCollections.subscribers);
}

function pageOffset(cursor: unknown): number {
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function defaultOcs(imsi: string, profileData: unknown) {
  return buildDefaultOpen5gsSubscriber(imsi, profileData).ocs!;
}

export async function scanSubscriberDocuments(cursor: unknown, phase: unknown) {
  if (phase === 'ocs') {
    return { nextCursor: '0', scannedCount: 0, anomalies: [] as SystemAnomaly[] };
  }

  const offset = pageOffset(cursor);
  const limit = 1000;
  const docs = await collection();
  const rows = await docs
    .find({}, { projection: { imsi: 1, ocs: 1 } })
    .sort({ imsi: 1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  const anomalies: SystemAnomaly[] = [];

  for (const row of rows) {
    let missingCount = 0;
    if (!row.ocs?.traffic) missingCount++;
    if (!row.ocs?.imsi) missingCount++;
    if (!row.ocs?.account) missingCount++;
    if (!row.ocs?.rating) missingCount++;

    if (missingCount > 0) {
      anomalies.push({
        imsi: row.imsi,
        type: 'missing_config',
        details: `Missing ${missingCount}/4 OCS tables`,
      });
      continue;
    }

    const balance = row.ocs?.account?.balance;
    if (balance === undefined || balance === null) {
      anomalies.push({ imsi: row.imsi, type: 'balance_mismatch', details: 'Balance field is null or undefined' });
    } else if (Number.isNaN(Number(balance))) {
      anomalies.push({ imsi: row.imsi, type: 'balance_mismatch', details: 'Balance format evaluates to NaN' });
    }
  }

  return {
    nextCursor: rows.length === limit ? String(offset + rows.length) : '0',
    scannedCount: rows.length,
    anomalies,
  };
}

export async function healSubscriberDocument(imsi: string, type: string, profileName?: string) {
  const docs = await collection();
  const existing = await docs.findOne({ imsi });
  const profile = profileName ? await getProfile(profileName) : null;

  if (type === 'orphan_ocs') {
    const doc = buildDefaultOpen5gsSubscriber(imsi, profile || undefined);
    await docs.updateOne({ imsi }, { $setOnInsert: doc }, { upsert: true });
    return;
  }

  if (!existing) {
    const doc = buildDefaultOpen5gsSubscriber(imsi, profile || undefined);
    await docs.insertOne(doc as SubscriberDoc);
    return;
  }

  if (type === 'missing_config') {
    const fallback = defaultOcs(imsi, profile || undefined);
    await docs.updateOne(
      { imsi },
      {
        $set: {
          'ocs.traffic': existing.ocs?.traffic || fallback.traffic,
          'ocs.imsi': existing.ocs?.imsi || fallback.imsi,
          'ocs.account': existing.ocs?.account || fallback.account,
          'ocs.rating': existing.ocs?.rating || fallback.rating,
          updated_at: new Date(),
        },
      }
    );
    return;
  }

  if (type === 'balance_mismatch') {
    const fallbackBalance = String(profile?.ocsDefaults?.balance ?? '10000');
    const fallbackCurrency = String(profile?.ocsDefaults?.currency ?? existing.ocs?.account?.currency ?? 'USD');
    await docs.updateOne(
      { imsi },
      {
        $set: {
          'ocs.account': {
            ...(existing.ocs?.account || { account_id: imsi }),
            account_id: existing.ocs?.account?.account_id || imsi,
            balance: fallbackBalance,
            currency: fallbackCurrency,
          },
          updated_at: new Date(),
        },
      }
    );
  }
}
