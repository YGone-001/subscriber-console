import { AnyBulkWriteOperation, Document, Filter, Long, MongoServerError, ObjectId } from 'mongodb';
import { getAppCollection, getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import {
  buildDefaultOpen5gsSubscriber,
  buildOpen5gsSubscriberFromLegacy,
  open5gsToLegacyState,
} from '@/lib/open5gsSubscriber';
import {
  cloneOcsProvisioningFromReference,
  deleteOcsProvisioning,
  getTariffPlan,
  provisionOcsSubscriber,
  readOcsProvisioning,
  readOcsProvisioningForImsis,
} from '@/server/repositories/ocsBillingRepository';
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
  policyName?: string;
  policyStatus?: string;
  traffic: {
    total: number;
    used: number;
    balance: number;
  };
  sms: {
    total: number;
    used: number;
    balance: number;
  };
  lastActive: string;
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
  trafficTotal?: unknown;
  trafficBalance?: unknown;
  smsTotal?: unknown;
  smsBalance?: unknown;
  profileName?: string;
  planId?: unknown;
  strategy?: 'skip' | 'overwrite';
};

type BatchCreateResult = {
  createdImsis: string[];
  skippedImsis: string[];
  failedImsis: string[];
  metrics: {
    totalTraffic: number;
    batchSize: number;
  };
};

type ImportRecord = Record<string, unknown> & {
  imsi?: unknown;
  k?: unknown;
  opc?: unknown;
  op?: unknown;
  amf?: unknown;
  traffic_total?: unknown;
  traffic_balance?: unknown;
  sms_total?: unknown;
  sms_balance?: unknown;
  plan_id?: unknown;
  access_restriction_data?: unknown;
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

function numericValue(value: unknown, fallback = 0): number {
  if (Long.isLong(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cloneMongoValue<T>(value: T): T {
  if (value instanceof ObjectId) return new ObjectId() as T;
  if (Long.isLong(value) || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => cloneMongoValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneMongoValue(item)])
    ) as T;
  }
  return value;
}

function normalizedTraffic(balanceDoc?: { data_total?: unknown; data_used?: unknown; data_available?: unknown } | null) {
  const balance = numericValue(balanceDoc?.data_available);
  let total = numericValue(balanceDoc?.data_total, balance);
  const used = numericValue(balanceDoc?.data_used);

  if (!Number.isFinite(total)) total = balance;
  if (total < balance) total = balance;

  return {
    total,
    balance,
    used: Math.max(0, used || total - balance),
  };
}

function normalizedSms(balanceDoc?: { sms_total?: unknown; sms_used?: unknown; sms_available?: unknown } | null) {
  const balance = numericValue(balanceDoc?.sms_available);
  let total = numericValue(balanceDoc?.sms_total, balance);
  const used = numericValue(balanceDoc?.sms_used);

  if (!Number.isFinite(total)) total = balance;
  if (total < balance) total = balance;

  return {
    total,
    balance,
    used: Math.max(0, used || total - balance),
  };
}

type TimestampDoc = {
  _id?: ObjectId;
  updated_at?: unknown;
  created_at?: unknown;
  webui_meta?: {
    updated_at?: unknown;
    created_at?: unknown;
  };
};

function objectIdTimestamp(doc?: TimestampDoc | null): Date | undefined {
  return doc?._id instanceof ObjectId ? doc._id.getTimestamp() : undefined;
}

function lastActive(
  open5gsDoc?: TimestampDoc | null,
  subscriberDoc?: TimestampDoc | null,
  balanceDoc?: { updated_at?: unknown } | null
): string {
  const raw =
    subscriberDoc?.updated_at ||
    open5gsDoc?.webui_meta?.updated_at ||
    open5gsDoc?.updated_at ||
    subscriberDoc?.created_at ||
    open5gsDoc?.webui_meta?.created_at ||
    open5gsDoc?.created_at ||
    objectIdTimestamp(open5gsDoc) ||
    balanceDoc?.updated_at;
  const date = raw instanceof Date || typeof raw === 'string' || typeof raw === 'number'
    ? new Date(raw)
    : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function statusFromAccessRestriction(accessRestriction: unknown): string {
  const ard = Number(accessRestriction);
  if (ard === 255) return 'Suspended';
  if (ard > 0 && ard !== 32) return 'Partial Restricted';
  return 'Active';
}

async function subscribersCollection() {
  return getOpen5gsCollection<SubscriberDoc>(mongoCollections.subscribers);
}

async function profilesCollection() {
  return getAppCollection<ProfileDoc>(mongoCollections.profiles);
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function msisdnFromLegacyPayload(payload: { sub4G?: unknown }): string {
  const sub4G = payload.sub4G && typeof payload.sub4G === 'object' ? payload.sub4G as Record<string, unknown> : {};
  const msisdnList = Array.isArray(sub4G.msisdnList) ? sub4G.msisdnList : [];
  const first = msisdnList[0] && typeof msisdnList[0] === 'object' ? msisdnList[0] as Record<string, unknown> : {};
  return asString(first.msisdn);
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

function profileOcs(profile: ProfileDoc | null | undefined): Record<string, unknown> {
  return profile?.ocsDefaults || profile?.ocs_defaults || {};
}

async function assertTariffPlanAssignable(planId: unknown) {
  const plan = await getTariffPlan(planId);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
  if (plan.status === 'disabled') throw new Error('OCS_PLAN_DISABLED');
  return plan;
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
  profileData: ProfileDoc | null
): Open5gsSubscriberDocument {
  const auth4G = profileData?.auth
    ? { ...profileData.auth, sqn: 1 }
    : { k: '00000000000000000000000000000000', opc: '00000000000000000000000000000000', sqn: 1, amf: '8000' };
  const sub4G = {
    ambr: profileData?.ambr,
    sliceList: profileData?.sliceList,
    access_restriction_data: 32,
    network_access_mode: 0,
  };
  return buildOpen5gsSubscriberFromLegacy(imsi, {
    sub4G,
    auth4G,
  });
}

function csvDocForRecord(record: ImportRecord): Open5gsSubscriberDocument | null {
  const imsi = asString(record.imsi).trim();
  if (!isValidImsi(imsi)) return null;

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
  });
}

function toSubscriberRow(
  doc: Open5gsSubscriberDocument,
  ocsSubscriber: { plan_id?: string; updated_at?: unknown; created_at?: unknown } | null | undefined,
  balance: { data_total?: unknown; data_used?: unknown; data_available?: unknown; updated_at?: unknown } | null | undefined,
  smsBalance: { sms_total?: unknown; sms_used?: unknown; sms_available?: unknown } | null | undefined,
  tariffPlan?: { name?: string; status?: string } | null
): SubscriberRow {
  const traffic = normalizedTraffic(balance);
  const sms = normalizedSms(smsBalance);
  const ard = Number(doc.access_restriction_data ?? 32);

  return {
    imsi: doc.imsi,
    status: statusFromAccessRestriction(ard),
    ard,
    plmn: doc.imsi.slice(0, 5) || '45400',
    profile: doc.webui_meta?.profile_name || '',
    policy: ocsSubscriber?.plan_id || '',
    policyName: tariffPlan?.name || ocsSubscriber?.plan_id || '',
    policyStatus: tariffPlan?.status || '',
    traffic,
    sms,
    lastActive: lastActive(doc, ocsSubscriber, balance),
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
  const ocs = await readOcsProvisioningForImsis(docs.map((doc) => doc.imsi));

  return {
    subscribers: docs.map((doc) => {
      const ocsSubscriber = ocs.subscribers.get(doc.imsi);
      const planId = ocsSubscriber?.plan_id || 'plan_default_10gb';
      return toSubscriberRow(
        doc,
        ocsSubscriber,
        ocs.balances.get(doc.imsi),
        ocs.balances.get(doc.imsi),
        ocs.tariffPlans.get(planId)
      );
    }),
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
  const state = open5gsToLegacyState(doc);
  if (!state) return null;

  const ocs = await readOcsProvisioning(imsi);
  return {
    ...state,
    ocsTraffic: ocs.traffic,
    ocsImsi: ocs.subscriber
      ? {
          account_id: imsi,
          imsi,
          msisdn: ocs.subscriber.msisdn,
          status: ocs.subscriber.status,
          plan_id: ocs.subscriber.plan_id,
        }
      : null,
    ocsTariffPlan: ocs.tariffPlan,
  };
}

export async function createDefaultSubscriber(imsi: string, planId?: unknown): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const doc = buildDefaultOpen5gsSubscriber(imsi);
  await assertTariffPlanAssignable(planId);

  try {
    await collection.insertOne(doc as SubscriberDoc);
    await provisionOcsSubscriber({ imsi, planId });
    return doc;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new Error('SUBSCRIBER_EXISTS');
    }
    throw error;
  }
}

export async function createSubscriberFromReference(
  imsi: string,
  referenceImsi: string
): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const [existing, reference] = await Promise.all([
    collection.findOne({ imsi }),
    collection.findOne({ imsi: referenceImsi }),
  ]);

  if (existing) throw new Error('SUBSCRIBER_EXISTS');
  if (!reference) throw new Error('REFERENCE_SUBSCRIBER_NOT_FOUND');

  const doc = cloneMongoValue(reference) as SubscriberDoc;
  delete (doc as { _id?: unknown })._id;
  doc.imsi = imsi;

  try {
    await collection.insertOne(doc);
    await cloneOcsProvisioningFromReference(imsi, referenceImsi);
    return doc;
  } catch (error) {
    await collection.deleteOne({ imsi }).catch(() => {});
    if (isDuplicateKey(error)) throw new Error('SUBSCRIBER_EXISTS');
    throw error;
  }
}

export async function updateSubscriberFromLegacy(
  imsi: string,
  payload: {
    sub4G?: unknown;
    auth4G?: unknown;
    ocsTraffic?: unknown;
  }
): Promise<Open5gsSubscriberDocument> {
  const collection = await subscribersCollection();
  const existing = await collection.findOne({ imsi });
  const next = buildOpen5gsSubscriberFromLegacy(imsi, payload, existing);
  const ocsTraffic = payload.ocsTraffic as Record<string, unknown> | undefined;
  const requestedPlanId = ocsTraffic?.planId ?? ocsTraffic?.plan_id;

  if (requestedPlanId !== undefined && requestedPlanId !== null && requestedPlanId !== '') {
    const current = await readOcsProvisioning(imsi);
    const currentPlanId = current.subscriber?.plan_id || 'plan_default_10gb';
    if (String(requestedPlanId) !== currentPlanId) {
      await assertTariffPlanAssignable(requestedPlanId);
    }
  }

  await collection.replaceOne(
    { imsi },
    next as SubscriberDoc,
    { upsert: true }
  );
  await provisionOcsSubscriber({
    imsi,
    planId: ocsTraffic?.planId ?? ocsTraffic?.plan_id,
    msisdn: msisdnFromLegacyPayload(payload),
    total: ocsTraffic?.traffic_total,
    available: ocsTraffic?.traffic_balance,
    voiceTotal: ocsTraffic?.voice_total,
    voiceAvailable: ocsTraffic?.voice_balance,
    smsTotal: ocsTraffic?.sms_total,
    smsAvailable: ocsTraffic?.sms_balance,
  });

  return next;
}

export async function deleteSubscriber(imsi: string): Promise<boolean> {
  const collection = await subscribersCollection();
  const result = await collection.deleteOne({ imsi });
  if (result.deletedCount > 0) await deleteOcsProvisioning(imsi);
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
  const initialTotal = asNumber(
    options.trafficTotal ?? ocs.trafficTotal ?? ocs.traffic_total ?? options.trafficBalance ?? ocs.trafficBalance ?? ocs.traffic_balance,
    5368709120
  );
  const initialBalance = asNumber(
    options.trafficBalance ?? ocs.trafficBalance ?? ocs.traffic_balance,
    initialTotal
  );
  const initialSmsTotal = asNumber(
    options.smsTotal ?? ocs.smsTotal ?? ocs.sms_total ?? options.smsBalance ?? ocs.smsBalance ?? ocs.sms_balance,
    100
  );
  const initialSmsBalance = asNumber(
    options.smsBalance ?? ocs.smsBalance ?? ocs.sms_balance,
    initialSmsTotal
  );
  const targetPlanId = options.planId ?? ocs.planId ?? ocs.plan_id;
  await assertTariffPlanAssignable(targetPlanId);

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

    const doc = batchDocForImsi(imsi, profileData);

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
  await Promise.all(successfulImsis.map((imsi) =>
    provisionOcsSubscriber({
      imsi,
      planId: targetPlanId,
      total: initialTotal,
      available: initialBalance,
      smsTotal: initialSmsTotal,
      smsAvailable: initialSmsBalance,
    })
  ));

  return {
    createdImsis: successfulImsis,
    skippedImsis,
    failedImsis,
    metrics: {
      totalTraffic: initialTotal * successfulImsis.length,
      batchSize: successfulImsis.length,
    },
  };
}

export async function importSubscribersFromRecords(records: ImportRecord[], overwrite: boolean): Promise<ImportResult> {
  const normalized = records
    .map((record) => ({ record, doc: csvDocForRecord(record) }))
    .filter((item): item is { record: ImportRecord; doc: Open5gsSubscriberDocument } => item.doc !== null);
  const planIds = Array.from(new Set(
    normalized
      .map(({ record }) => asString(record.plan_id, 'plan_default_10gb').trim() || 'plan_default_10gb')
  ));
  await Promise.all(planIds.map((planId) => assertTariffPlanAssignable(planId)));
  const imsis = normalized.map((item) => item.doc.imsi);
  const existing = await existingImsiSet(imsis);
  const operations: AnyBulkWriteOperation<SubscriberDoc>[] = [];
  const pendingImsis: string[] = [];
  const provisioningByImsi = new Map<string, { total: number; available: number; smsTotal: number; smsAvailable: number; planId?: unknown }>();
  let skipped = records.length - normalized.length;

  for (const { record, doc } of normalized) {
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
    const available = asNumber(record.traffic_balance, 10737418240);
    const total = asNumber(record.traffic_total, available);
    const smsAvailable = asNumber(record.sms_balance, 100);
    const smsTotal = asNumber(record.sms_total, smsAvailable);
    provisioningByImsi.set(doc.imsi, { total, available, smsTotal, smsAvailable, planId: record.plan_id });
    pendingImsis.push(doc.imsi);
  }

  const { successfulImsis, failedImsis } = await bulkWriteSubscribers(operations, pendingImsis);
  await Promise.all(successfulImsis.map((imsi) => {
    const provisioning = provisioningByImsi.get(imsi);
    return provisionOcsSubscriber({
      imsi,
      planId: provisioning?.planId,
      total: provisioning?.total,
      available: provisioning?.available,
      smsTotal: provisioning?.smsTotal,
      smsAvailable: provisioning?.smsAvailable,
    });
  }));

  return {
    imported: successfulImsis.length,
    skipped,
    failed: failedImsis.length,
    importedImsis: successfulImsis,
    failedImsis,
  };
}
