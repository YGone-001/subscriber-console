import { AnyBulkWriteOperation, Document, Filter, MongoServerError } from 'mongodb';
import { getMongoCollection, mongoCollections } from '@/lib/mongo';
import {
  buildDefaultOpen5gsSubscriber,
  buildOpen5gsSubscriberFromLegacy,
  open5gsToLegacyState,
} from '@/lib/open5gsSubscriber';
import type { LegacySubscriberState, Open5gsSubscriberDocument } from '@/types/open5gs';

type SubscriberDoc = Open5gsSubscriberDocument & Document;

export type SubscriberListResult<T> = {
  subscribers: T[];
  total: number;
  page: number;
  limit: number;
};

export type SubscriberRow = {
  imsi: string;
  status: string;
  ard: number;
  plmn: string;
  profile: string;
  policy: string;
  traffic: {
    total: number;
    used: number;
    balance: number;
  };
  lastActive: string;
};

type RatingDoc = {
  rating_group_id: number;
  currency?: string;
  rates?: string | number;
  rates_type?: number;
};

type ProfileDoc = Document & {
  name?: string;
  auth?: Record<string, unknown>;
  ambr?: unknown;
  msisdnList?: unknown;
  sliceList?: unknown;
  ocsDefaults?: Record<string, unknown>;
  ocs_defaults?: Record<string, unknown>;
};

type BatchCreateOptions = {
  startImsi: string;
  count: number;
  plmn?: string;
  trafficTotal?: unknown;
  trafficBalance?: unknown;
  withhold?: unknown;
  withholdingResidue?: unknown;
  withholdingTime?: unknown;
  ratingGroupId?: unknown;
  profileName?: string;
  currency?: string;
  balance?: unknown;
  strategy?: 'skip' | 'overwrite';
};

type BatchCreateResult = {
  createdImsis: string[];
  skippedImsis: string[];
  failedImsis: string[];
  metrics: {
    totalTraffic: number;
    batchSize: number;
    plmn: string;
    ratingGroupId?: unknown;
  };
};

type ImportRecord = Record<string, unknown> & {
  imsi?: unknown;
  k?: unknown;
  opc?: unknown;
  op?: unknown;
  amf?: unknown;
  traffic_balance?: unknown;
  plmn?: unknown;
  currency?: unknown;
  balance?: unknown;
  access_restriction_data?: unknown;
  withhold?: unknown;
};

type ImportResult = {
  imported: number;
  skipped: number;
  failed: number;
  importedImsis: string[];
  failedImsis: string[];
};

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function safePage(page: number): number {
  return Math.max(1, Number.isFinite(page) ? page : 1);
}

function safeLimit(limit: number): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? limit : 50), 200);
}

function subscriberFilter(query = ''): Filter<SubscriberDoc> | null {
  const trimmed = query.trim();
  if (!trimmed) return {};
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  return { imsi: { $regex: `^${trimmed}` } };
}

function ratingTypeLabel(type: unknown): string {
  const value = Number(type);
  if (value === 1) return 'Time';
  if (value === 2) return 'Vol';
  if (value === 3) return 'Event';
  return 'Flat';
}

function firstRatingGroupId(doc: Open5gsSubscriberDocument): string | null {
  const ratesMap = doc.ocs?.rating?.rates_map;
  if (!ratesMap) return null;
  const first = Object.values(ratesMap)[0];
  return first === undefined || first === null || first === '' ? null : String(first);
}

function normalizedTraffic(doc: Open5gsSubscriberDocument) {
  const traffic = doc.ocs?.traffic || {};
  const balance = Number(traffic.traffic_balance) || 0;
  let total = Number(traffic.traffic_total);

  if (!Number.isFinite(total)) total = balance;
  if (total < balance) total = balance;

  return {
    total,
    balance,
    used: Math.max(0, total - balance),
  };
}

function lastActive(doc: Open5gsSubscriberDocument): string {
  const raw = doc.ocs?.imsi?.last_update_time || doc.updated_at || doc.created_at;
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function statusFromAccessRestriction(accessRestriction: unknown): string {
  const ard = Number(accessRestriction);
  if (ard === 255) return 'Suspended';
  if (ard > 0 && ard !== 32) return 'Partial Restricted';
  return 'Active';
}

async function subscribersCollection() {
  return getMongoCollection<SubscriberDoc>(mongoCollections.subscribers);
}

async function ratingsCollection() {
  return getMongoCollection<RatingDoc & Document>(mongoCollections.ratings);
}

async function profilesCollection() {
  return getMongoCollection<ProfileDoc>(mongoCollections.profiles);
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function isValidImsi(imsi: string): boolean {
  return /^\d{15}$/.test(imsi);
}

function generateImsiRange(startImsi: string, count: number): string[] {
  const start = BigInt(startImsi);
  return Array.from({ length: count }, (_, index) => (start + BigInt(index)).toString().padStart(15, '0'));
}

function ensureImsiRange(imsis: string[]) {
  const invalid = imsis.find((imsi) => !isValidImsi(imsi));
  if (invalid) throw new Error('IMSI_RANGE_OVERFLOW');
}

async function findProfile(profileName?: string): Promise<ProfileDoc | null> {
  if (!profileName) return null;
  const collection = await profilesCollection();
  return collection.findOne({ name: profileName });
}

async function findRating(ratingGroupId: unknown): Promise<RatingDoc | null> {
  if (ratingGroupId === undefined || ratingGroupId === null || ratingGroupId === '') return null;
  const collection = await ratingsCollection();
  return collection.findOne({ rating_group_id: Number(ratingGroupId) });
}

function profileOcs(profile: ProfileDoc | null | undefined): Record<string, unknown> {
  return profile?.ocsDefaults || profile?.ocs_defaults || {};
}

async function existingImsiSet(imsis: string[]): Promise<Set<string>> {
  const collection = await subscribersCollection();
  const docs = await collection
    .find({ imsi: { $in: imsis } }, { projection: { imsi: 1 } })
    .toArray();
  return new Set(docs.map((doc) => doc.imsi));
}

function bulkWriteErrorIndexes(error: unknown): Set<number> {
  const candidate = error as {
    writeErrors?: Array<{ index?: number }>;
    result?: { result?: { writeErrors?: Array<{ index?: number }> } };
  };
  const writeErrors = candidate.writeErrors || candidate.result?.result?.writeErrors || [];
  return new Set(
    writeErrors
      .map((item) => Number(item.index))
      .filter((index) => Number.isInteger(index) && index >= 0)
  );
}

async function bulkWriteSubscribers(
  operations: AnyBulkWriteOperation<SubscriberDoc>[],
  operationImsis: string[]
): Promise<{ successfulImsis: string[]; failedImsis: string[] }> {
  if (operations.length === 0) return { successfulImsis: [], failedImsis: [] };

  const collection = await subscribersCollection();

  try {
    await collection.bulkWrite(operations, { ordered: false });
    return { successfulImsis: operationImsis, failedImsis: [] };
  } catch (error) {
    const failedIndexes = bulkWriteErrorIndexes(error);
    if (failedIndexes.size === 0) throw error;

    return {
      successfulImsis: operationImsis.filter((_, index) => !failedIndexes.has(index)),
      failedImsis: operationImsis.filter((_, index) => failedIndexes.has(index)),
    };
  }
}

function batchDocForImsi(
  imsi: string,
  profileData: ProfileDoc | null,
  options: {
    effectivePlmn: string;
    initialTotal: number;
    initialBalance: number;
    withholdValue: number;
    withholdingResidueValue: number;
    withholdingTimeValue: number;
    accountBalance: string;
    accountCurrency: string;
    effectiveRatingGroupId?: unknown;
    ratingMapValue?: unknown;
  }
): Open5gsSubscriberDocument {
  const auth4G = profileData?.auth
    ? { ...profileData.auth, sqn: 1 }
    : { k: '00000000000000000000000000000000', opc: '00000000000000000000000000000000', sqn: 1, amf: '8000' };
  const sub4G = {
    ambr: profileData?.ambr,
    msisdnList: profileData?.msisdnList,
    sliceList: profileData?.sliceList,
    access_restriction_data: 32,
    network_access_mode: 0,
  };
  const ocsImsiSet = options.effectiveRatingGroupId !== undefined && options.effectiveRatingGroupId !== null && options.effectiveRatingGroupId !== ''
    ? {
        rates_map: { [options.effectivePlmn]: options.ratingMapValue ?? Number(options.effectiveRatingGroupId) },
        imsi,
      }
    : undefined;

  return buildOpen5gsSubscriberFromLegacy(imsi, {
    sub4G,
    auth4G,
    ocsTraffic: {
      traffic_total: options.initialTotal,
      traffic_balance: options.initialBalance,
      imsi,
      plmn: options.effectivePlmn,
    },
    ocsImsi: {
      account_id: imsi,
      imsi,
      withhold: options.withholdValue,
      withholding_residue: options.withholdingResidueValue,
      withholding_time: options.withholdingTimeValue,
    },
    ocsAccount: {
      account_id: imsi,
      balance: options.accountBalance,
      currency: options.accountCurrency,
    },
    ocsImsiSet,
  });
}

function csvDocForRecord(record: ImportRecord): Open5gsSubscriberDocument | null {
  const imsi = asString(record.imsi).trim();
  if (!isValidImsi(imsi)) return null;

  const trafficBalance = asNumber(record.traffic_balance, 10737418240);
  const accessRestriction = asNumber(record.access_restriction_data, 32);

  return buildOpen5gsSubscriberFromLegacy(imsi, {
    sub4G: {
      access_restriction_data: accessRestriction,
      network_access_mode: 0,
    },
    auth4G: {
      k: asString(record.k, '00000000000000000000000000000000'),
      opc: asString(record.opc ?? record.op, '00000000000000000000000000000000'),
      sqn: 1,
      amf: asString(record.amf, '8000'),
    },
    ocsTraffic: {
      imsi,
      plmn: asString(record.plmn, '45400'),
      traffic_total: trafficBalance,
      traffic_balance: trafficBalance,
    },
    ocsImsi: {
      imsi,
      account_id: imsi,
      withhold: asNumber(record.withhold, 100),
      withholding_residue: 0,
      withholding_time: 3600,
    },
    ocsAccount: {
      account_id: imsi,
      balance: asString(record.balance, '10000'),
      currency: asString(record.currency, 'USD'),
    },
    ocsImsiSet: {
      rates_map: {},
      imsi,
    },
  });
}

async function ratingMapFor(docs: Open5gsSubscriberDocument[]): Promise<Map<string, RatingDoc>> {
  const ids = Array.from(new Set(docs.map(firstRatingGroupId).filter((id): id is string => !!id)));
  const ratings = new Map<string, RatingDoc>();
  if (ids.length === 0) return ratings;

  const collection = await ratingsCollection();
  const rows = await collection
    .find({ rating_group_id: { $in: ids.map((id) => Number(id)) } })
    .toArray();

  rows.forEach((row) => ratings.set(String(row.rating_group_id), row));
  return ratings;
}

function toSubscriberRow(doc: Open5gsSubscriberDocument, ratings: Map<string, RatingDoc>): SubscriberRow {
  const ratingGroupId = firstRatingGroupId(doc);
  const rating = ratingGroupId ? ratings.get(ratingGroupId) : null;
  const policy = rating
    ? `${rating.currency || 'USD'} ${rating.rates || '0'} (${ratingTypeLabel(rating.rates_type)})`
    : '';
  const traffic = normalizedTraffic(doc);
  const ard = Number(doc.access_restriction_data ?? 32);

  return {
    imsi: doc.imsi,
    status: statusFromAccessRestriction(ard),
    ard,
    plmn: doc.ocs?.traffic?.plmn || '45400',
    profile: doc.webui_meta?.profile_name || '',
    policy,
    traffic,
    lastActive: lastActive(doc),
  };
}

export async function listSubscriberImsis(
  page: number,
  limit: number,
  query = ''
): Promise<SubscriberListResult<string>> {
  const filter = subscriberFilter(query);
  const pageValue = safePage(page);
  const limitValue = safeLimit(limit);

  if (!filter) {
    return { subscribers: [], total: 0, page: pageValue, limit: limitValue };
  }

  const collection = await subscribersCollection();
  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(filter, { projection: { imsi: 1 } })
      .sort({ imsi: 1 })
      .skip((pageValue - 1) * limitValue)
      .limit(limitValue)
      .toArray(),
  ]);

  return {
    subscribers: docs.map((doc) => doc.imsi),
    total,
    page: pageValue,
    limit: limitValue,
  };
}

export async function listSubscriberRows(
  page: number,
  limit: number,
  query = ''
): Promise<SubscriberListResult<SubscriberRow>> {
  const filter = subscriberFilter(query);
  const pageValue = safePage(page);
  const limitValue = safeLimit(limit);

  if (!filter) {
    return { subscribers: [], total: 0, page: pageValue, limit: limitValue };
  }

  const collection = await subscribersCollection();
  const [total, docs] = await Promise.all([
    collection.countDocuments(filter),
    collection
      .find(filter)
      .sort({ imsi: 1 })
      .skip((pageValue - 1) * limitValue)
      .limit(limitValue)
      .toArray(),
  ]);
  const ratings = await ratingMapFor(docs);

  return {
    subscribers: docs.map((doc) => toSubscriberRow(doc, ratings)),
    total,
    page: pageValue,
    limit: limitValue,
  };
}

export async function findSubscriberDocument(imsi: string): Promise<Open5gsSubscriberDocument | null> {
  const collection = await subscribersCollection();
  return collection.findOne({ imsi });
}

export async function findSubscriberLegacyState(imsi: string): Promise<LegacySubscriberState | null> {
  const doc = await findSubscriberDocument(imsi);
  return open5gsToLegacyState(doc);
}

export async function createDefaultSubscriber(imsi: string): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const doc = buildDefaultOpen5gsSubscriber(imsi);

  try {
    await collection.insertOne(doc as SubscriberDoc);
    return doc;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new Error('SUBSCRIBER_EXISTS');
    }
    throw error;
  }
}

export async function updateSubscriberFromLegacy(
  imsi: string,
  payload: {
    sub4G?: unknown;
    auth4G?: unknown;
    ocsImsi?: unknown;
    ocsTraffic?: unknown;
    ocsImsiSet?: unknown;
    ocsAccount?: unknown;
  }
): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const existing = await collection.findOne({ imsi });
  const next = buildOpen5gsSubscriberFromLegacy(imsi, payload, existing);

  await collection.replaceOne(
    { imsi },
    next as SubscriberDoc,
    { upsert: true }
  );

  return next;
}

export async function deleteSubscriber(imsi: string): Promise<boolean> {
  const collection = await subscribersCollection();
  const result = await collection.deleteOne({ imsi });
  return result.deletedCount > 0;
}

export async function precheckSubscriberImsis(imsis: string[]) {
  const validImsis = imsis.map((imsi) => String(imsi).trim()).filter(isValidImsi);
  const existing = await existingImsiSet(validImsis);

  return validImsis.map((imsi) => ({
    imsi,
    exists: existing.has(imsi),
  }));
}

export async function precheckSubscriberRange(startImsi: string, count: number) {
  const imsis = generateImsiRange(startImsi, count);
  ensureImsiRange(imsis);
  const existing = await existingImsiSet(imsis);
  const conflictImsis = imsis.filter((imsi) => existing.has(imsi));

  return {
    conflictCount: conflictImsis.length,
    conflictImsis,
    totalCount: count,
  };
}

export async function createSubscribersBatch(options: BatchCreateOptions): Promise<BatchCreateResult> {
  const profileData = await findProfile(options.profileName);
  const ocs = profileOcs(profileData);
  let effectiveRatingGroupId = options.ratingGroupId;

  if (effectiveRatingGroupId === undefined || effectiveRatingGroupId === null || effectiveRatingGroupId === '') {
    effectiveRatingGroupId = ocs.ratingGroupId ?? ocs.rating_group_id;
  }

  const ratingData = await findRating(effectiveRatingGroupId);
  const effectivePlmn = options.plmn || asString(ocs.plmn, '45400');
  const initialTotal = asNumber(
    options.trafficTotal ?? ocs.trafficTotal ?? ocs.traffic_total ?? options.trafficBalance ?? ocs.trafficBalance ?? ocs.traffic_balance,
    5368709120
  );
  const initialBalance = asNumber(
    options.trafficBalance ?? ocs.trafficBalance ?? ocs.traffic_balance,
    initialTotal
  );
  const withholdValue = asNumber(options.withhold ?? ocs.withhold, 100);
  const withholdingResidueValue = asNumber(
    options.withholdingResidue ?? ocs.withholdingResidue ?? ocs.withholding_residue,
    0
  );
  const withholdingTimeValue = asNumber(
    options.withholdingTime ?? ocs.withholdingTime ?? ocs.withholding_time,
    3600
  );
  const accountBalance = asString(options.balance ?? ocs.balance, '10000');
  const accountCurrency = options.currency || asString(ocs.currency, 'USD');
  const ratingMapValue = ratingData ? ratingData.rating_group_id : effectiveRatingGroupId;

  const imsis = generateImsiRange(options.startImsi, options.count);
  ensureImsiRange(imsis);
  const existing = options.strategy === 'skip' ? await existingImsiSet(imsis) : new Set<string>();
  const pendingImsis: string[] = [];
  const skippedImsis: string[] = [];
  const operations: AnyBulkWriteOperation<SubscriberDoc>[] = [];

  for (const imsi of imsis) {
    if (options.strategy === 'skip' && existing.has(imsi)) {
      skippedImsis.push(imsi);
      continue;
    }

    const doc = batchDocForImsi(imsi, profileData, {
      effectivePlmn,
      initialTotal,
      initialBalance,
      withholdValue,
      withholdingResidueValue,
      withholdingTimeValue,
      accountBalance,
      accountCurrency,
      effectiveRatingGroupId,
      ratingMapValue,
    });

    operations.push({
      replaceOne: {
        filter: { imsi },
        replacement: doc as SubscriberDoc,
        upsert: true,
      },
    });
    pendingImsis.push(imsi);
  }

  const { successfulImsis, failedImsis } = await bulkWriteSubscribers(operations, pendingImsis);

  return {
    createdImsis: successfulImsis,
    skippedImsis,
    failedImsis,
    metrics: {
      totalTraffic: initialTotal * successfulImsis.length,
      batchSize: successfulImsis.length,
      plmn: effectivePlmn,
      ratingGroupId: effectiveRatingGroupId,
    },
  };
}

export async function importSubscribersFromRecords(records: ImportRecord[], overwrite: boolean): Promise<ImportResult> {
  const normalized = records
    .map(csvDocForRecord)
    .filter((doc): doc is Open5gsSubscriberDocument => doc !== null);
  const imsis = normalized.map((doc) => doc.imsi);
  const existing = await existingImsiSet(imsis);
  const operations: AnyBulkWriteOperation<SubscriberDoc>[] = [];
  const pendingImsis: string[] = [];
  let skipped = records.length - normalized.length;

  for (const doc of normalized) {
    const exists = existing.has(doc.imsi);
    if (exists && !overwrite) {
      skipped++;
      continue;
    }

    operations.push({
      replaceOne: {
        filter: { imsi: doc.imsi },
        replacement: doc as SubscriberDoc,
        upsert: true,
      },
    });
    pendingImsis.push(doc.imsi);
  }

  const { successfulImsis, failedImsis } = await bulkWriteSubscribers(operations, pendingImsis);

  return {
    imported: successfulImsis.length,
    skipped,
    failed: failedImsis.length,
    importedImsis: successfulImsis,
    failedImsis,
  };
}
