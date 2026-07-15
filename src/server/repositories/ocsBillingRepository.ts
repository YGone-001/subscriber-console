import { Document, Long } from 'mongodb';
import { getAppCollection, getOpen5gsCollection, mongoCollections } from '@/lib/mongo';

export const DEFAULT_OCS_PLAN_ID = 'plan_default_10gb';
const DEFAULT_QUOTA_PER_GRANT = 10 * 1024 * 1024;
const DEFAULT_VOLUME_THRESHOLD = 8 * 1024 * 1024;
const DEFAULT_VALIDITY_TIME = 300;
const DEFAULT_TOTAL_BALANCE = 10 * 1024 * 1024 * 1024;

export type OcsTariffRule = {
  rule_id: string;
  apn: string;
  rating_group: Long | number;
  service_identifier: Long | number;
  charging_type: 'data_volume' | 'free' | string;
  unit: string;
  quota_per_grant: Long | number;
  validity_time: number;
  volume_threshold: Long | number;
  priority: number;
  status?: 'active' | 'disabled' | string;
  currency?: string;
  rates?: string;
  rates_type?: number;
};

type OcsTariffPlan = Document & {
  plan_id: string;
  status: 'active' | 'disabled' | string;
  quota_per_grant: Long | number;
  validity_time: number;
  volume_threshold: Long | number;
  rules: OcsTariffRule[];
  created_at?: Date | string;
  updated_at?: Date | string;
};

type OcsSubscriber = Document & {
  imsi: string;
  msisdn?: string;
  status: 'active' | 'suspended' | string;
  plan_id: string;
  created_at?: Date | string;
  updated_at?: Date | string;
};

type OcsBalance = Document & {
  imsi: string;
  data_total: Long | number;
  data_used: Long | number;
  data_reserved: Long | number;
  data_available: Long | number;
  version?: Long | number;
  created_at?: Date | string;
  updated_at?: Date | string;
  money_balance?: Long | number;
  plan_id?: string;
  status?: string;
  cycle_reset_at?: Date | string;
  cycle_start_at?: Date | string;
};

type LegacyRatingDoc = Document & {
  rating_group_id?: number;
  currency?: string;
  rates?: string | number;
  rates_type?: number;
};

export type RatingPolicy = {
  rating_group_id: number;
  currency: string;
  rates: string;
  rates_type: number;
  plan_id: string;
  rule_id: string;
  apn: string;
  service_identifier: number;
  charging_type: string;
  unit: string;
  quota_per_grant: number;
  validity_time: number;
  volume_threshold: number;
  priority: number;
  status: string;
};

export type OcsProvisioningInput = {
  imsi: string;
  msisdn?: unknown;
  planId?: unknown;
  total?: unknown;
  available?: unknown;
  status?: unknown;
};

function tariffPlansCollection() {
  return getOpen5gsCollection<OcsTariffPlan>(mongoCollections.ocsTariffPlans);
}

function ocsSubscribersCollection() {
  return getOpen5gsCollection<OcsSubscriber>(mongoCollections.ocsSubscribers);
}

function ocsBalancesCollection() {
  return getOpen5gsCollection<OcsBalance>(mongoCollections.ocsBalances);
}

function legacyRatingsCollection() {
  return getAppCollection<LegacyRatingDoc>(mongoCollections.ratings);
}

function toLong(value: unknown, fallback = 0): Long {
  if (Long.isLong(value)) return value;
  const parsed = Number(value);
  return Long.fromNumber(Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback);
}

function toNumber(value: unknown, fallback = 0): number {
  if (Long.isLong(value)) return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function ratesTypeToChargingType(value: unknown): string {
  const type = Number(value);
  if (type === 2) return 'data_volume';
  if (type === 4) return 'data_volume';
  if (type === 1) return 'time';
  if (type === 3) return 'event';
  return 'data_volume';
}

function defaultInternetRule(): OcsTariffRule {
  return {
    rule_id: 'internet_rg1001_si1',
    apn: 'internet',
    rating_group: Long.fromNumber(1001),
    service_identifier: Long.fromNumber(1),
    charging_type: 'data_volume',
    unit: 'octets',
    quota_per_grant: Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
    priority: 100,
    status: 'active',
  };
}

function defaultImsRule(): OcsTariffRule {
  return {
    rule_id: 'ims_rg2001_si2',
    apn: 'ims',
    rating_group: Long.fromNumber(2001),
    service_identifier: Long.fromNumber(2),
    charging_type: 'free',
    unit: 'octets',
    quota_per_grant: Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
    priority: 100,
  };
}

function defaultPlan(now = new Date()): OcsTariffPlan {
  return {
    plan_id: DEFAULT_OCS_PLAN_ID,
    name: 'Default 10GB Data Plan',
    status: 'active',
    quota_per_grant: Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
    unit: 'octets',
    rules: [defaultInternetRule(), defaultImsRule()],
    created_at: now,
    updated_at: now,
  };
}

function normalizePolicy(rule: OcsTariffRule, planId = DEFAULT_OCS_PLAN_ID): RatingPolicy {
  return {
    rating_group_id: toNumber(rule.rating_group),
    currency: asString(rule.currency, 'USD'),
    rates: asString(rule.rates, '0'),
    rates_type: Number(rule.rates_type) || 2,
    plan_id: planId,
    rule_id: rule.rule_id,
    apn: rule.apn,
    service_identifier: toNumber(rule.service_identifier),
    charging_type: rule.charging_type,
    unit: rule.unit || 'bytes',
    quota_per_grant: toNumber(rule.quota_per_grant),
    validity_time: Number(rule.validity_time) || 0,
    volume_threshold: toNumber(rule.volume_threshold),
    priority: Number(rule.priority) || 100,
    status: rule.status || 'active',
  };
}

async function getOrCreateDefaultPlan(): Promise<OcsTariffPlan> {
  const collection = await tariffPlansCollection();
  const existing = await collection.findOne({ plan_id: DEFAULT_OCS_PLAN_ID });
  if (!existing) {
    const plan = defaultPlan();
    await collection.insertOne(plan);
    return attachLegacyRatingRules(collection, plan);
  }

  return attachLegacyRatingRules(collection, existing);
}

function makeRule(input: {
  rating_group_id: unknown;
  currency?: unknown;
  rates?: unknown;
  rates_type?: unknown;
  apn?: unknown;
  service_identifier?: unknown;
  charging_type?: unknown;
  quota_per_grant?: unknown;
  validity_time?: unknown;
  volume_threshold?: unknown;
  priority?: unknown;
  status?: unknown;
}): OcsTariffRule {
  const ratingGroupId = Number(input.rating_group_id);
  const apn = asString(input.apn, 'internet');
  const serviceIdentifier = Number(input.service_identifier ?? 1);
  const chargingType = asString(input.charging_type, ratesTypeToChargingType(input.rates_type));

  return {
    rule_id: `${apn}_rg${ratingGroupId}_si${serviceIdentifier}`,
    apn,
    rating_group: Long.fromNumber(ratingGroupId),
    service_identifier: Long.fromNumber(serviceIdentifier),
    charging_type: chargingType,
    unit: 'octets',
    quota_per_grant: toLong(input.quota_per_grant, DEFAULT_QUOTA_PER_GRANT),
    validity_time: Number(input.validity_time ?? DEFAULT_VALIDITY_TIME),
    volume_threshold: toLong(input.volume_threshold, DEFAULT_VOLUME_THRESHOLD),
    priority: Number(input.priority ?? 100),
    status: asString(input.status, 'active'),
    currency: asString(input.currency, 'USD'),
    rates: asString(input.rates, '0'),
    rates_type: Number(input.rates_type) || 2,
  };
}

function nonSystemRules(plan: OcsTariffPlan): OcsTariffRule[] {
  return (plan.rules || []).filter((rule) => toNumber(rule.rating_group) > 0);
}

async function attachLegacyRatingRules(collection: Awaited<ReturnType<typeof tariffPlansCollection>>, plan: OcsTariffPlan): Promise<OcsTariffPlan> {
  const legacyCollection = await legacyRatingsCollection();
  const legacyRatings = await legacyCollection
    .find({ rating_group_id: { $exists: true } })
    .sort({ rating_group_id: 1 })
    .toArray();
  if (legacyRatings.length === 0) return plan;

  const existingRatingGroups = new Set((plan.rules || []).map((rule) => toNumber(rule.rating_group)));
  const importedRules = legacyRatings
    .filter((rating) => Number.isFinite(Number(rating.rating_group_id)))
    .filter((rating) => !existingRatingGroups.has(Number(rating.rating_group_id)))
    .map((rating) => makeRule({
      rating_group_id: rating.rating_group_id,
      currency: rating.currency,
      rates: rating.rates,
      rates_type: rating.rates_type,
    }));
  if (importedRules.length === 0) return plan;

  const next = {
    ...plan,
    rules: [...(plan.rules || []), ...importedRules],
    updated_at: new Date(),
  };
  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return next;
}

export async function listRatingPolicies(): Promise<RatingPolicy[]> {
  const plan = await getOrCreateDefaultPlan();
  return nonSystemRules(plan)
    .map((rule) => normalizePolicy(rule, plan.plan_id))
    .sort((a, b) => a.rating_group_id - b.rating_group_id);
}

export async function getRatingPolicy(id: string | number): Promise<RatingPolicy | null> {
  const plan = await getOrCreateDefaultPlan();
  const rule = nonSystemRules(plan).find((item) => String(toNumber(item.rating_group)) === String(id));
  return rule ? normalizePolicy(rule, plan.plan_id) : null;
}

export async function createRatingPolicy(input: Parameters<typeof makeRule>[0]): Promise<RatingPolicy> {
  const collection = await tariffPlansCollection();
  const plan = await getOrCreateDefaultPlan();
  const rule = makeRule(input);
  const ratingGroupId = toNumber(rule.rating_group);

  if ((plan.rules || []).some((item) => toNumber(item.rating_group) === ratingGroupId)) {
    throw new Error('RATING_EXISTS');
  }

  const next = {
    ...plan,
    rules: [...(plan.rules || []), rule],
    updated_at: new Date(),
  };
  await collection.replaceOne({ plan_id: DEFAULT_OCS_PLAN_ID }, next);
  return normalizePolicy(rule, plan.plan_id);
}

export async function updateRatingPolicy(id: string | number, input: Partial<Parameters<typeof makeRule>[0]>): Promise<RatingPolicy> {
  const collection = await tariffPlansCollection();
  const plan = await getOrCreateDefaultPlan();
  const ratingGroupId = Number(id);
  const existing = (plan.rules || []).find((rule) => toNumber(rule.rating_group) === ratingGroupId);
  const replacement = makeRule({
    ...existing,
    ...input,
    rating_group_id: ratingGroupId,
  });
  const nextRules = (plan.rules || []).filter((rule) => toNumber(rule.rating_group) !== ratingGroupId);
  const next = {
    ...plan,
    rules: [...nextRules, replacement],
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: DEFAULT_OCS_PLAN_ID }, next);
  return normalizePolicy(replacement, plan.plan_id);
}

export async function deleteRatingPolicy(id: string | number) {
  const collection = await tariffPlansCollection();
  const plan = await getOrCreateDefaultPlan();
  const ratingGroupId = Number(id);
  const before = plan.rules || [];
  const next = {
    ...plan,
    rules: before.filter((rule) => toNumber(rule.rating_group) !== ratingGroupId),
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: DEFAULT_OCS_PLAN_ID }, next);
  return { deleted: before.length !== next.rules.length, references: { count: 0, examples: [] as string[] } };
}

export async function findRatingPolicy(id: unknown): Promise<RatingPolicy | null> {
  if (id === undefined || id === null || id === '') return null;
  return getRatingPolicy(String(id));
}

export async function firstActiveRatingPolicy(): Promise<RatingPolicy | null> {
  const policies = await listRatingPolicies();
  return policies.find((policy) => policy.status === 'active') || policies[0] || null;
}

export async function provisionOcsSubscriber(input: OcsProvisioningInput): Promise<void> {
  const now = new Date();
  const planId = asString(input.planId, DEFAULT_OCS_PLAN_ID);
  const dataTotal = toNumber(input.total, DEFAULT_TOTAL_BALANCE);
  const requestedAvailable = toNumber(input.available, dataTotal);
  const [subscriberCollection, balanceCollection] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
  ]);
  const existingBalance = await balanceCollection.findOne({ imsi: input.imsi });
  const hasAvailableInput = input.available !== undefined && input.available !== null && input.available !== '';
  const dataAvailable = Math.min(Math.max(0, requestedAvailable), dataTotal);
  const derivedReserved = dataAvailable < dataTotal
    ? Math.min(DEFAULT_QUOTA_PER_GRANT, dataTotal - dataAvailable)
    : 0;
  const dataReserved = hasAvailableInput
    ? derivedReserved
    : existingBalance
    ? toNumber(existingBalance.data_reserved)
    : dataAvailable < dataTotal
      ? derivedReserved
      : 0;
  const dataUsed = hasAvailableInput
    ? Math.max(0, dataTotal - dataReserved - dataAvailable)
    : existingBalance
    ? toNumber(existingBalance.data_used)
    : Math.max(0, dataTotal - dataReserved - dataAvailable);
  const nextTotal = Math.max(dataTotal, dataUsed + dataReserved + dataAvailable);
  const version = existingBalance ? toNumber(existingBalance.version, 0) + 1 : 1;

  await getOrCreateDefaultPlan();
  await subscriberCollection.updateOne(
    { imsi: input.imsi },
    {
      $set: {
        msisdn: asString(input.msisdn),
        status: asString(input.status, 'active'),
        plan_id: planId,
        updated_at: now,
      },
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );
  await balanceCollection.updateOne(
    { imsi: input.imsi },
    {
      $set: {
        data_total: Long.fromNumber(nextTotal),
        data_used: Long.fromNumber(dataUsed),
        data_reserved: Long.fromNumber(dataReserved),
        data_available: Long.fromNumber(dataAvailable),
        money_balance: Long.ZERO,
        plan_id: planId,
        status: asString(input.status, 'active'),
        version: Long.fromNumber(version),
        updated_at: now,
        cycle_start_at: existingBalance?.cycle_start_at || now,
        cycle_reset_at: existingBalance?.cycle_reset_at || now,
      },
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );
}

export async function deleteOcsProvisioning(imsi: string): Promise<void> {
  const [subscriberCollection, balanceCollection] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
  ]);
  await Promise.all([
    subscriberCollection.deleteOne({ imsi }),
    balanceCollection.deleteOne({ imsi }),
  ]);
}

function referencedMsisdn(sourceMsisdn: unknown, sourceImsi: string, targetImsi: string): string {
  const raw = asString(sourceMsisdn);
  const sourceSuffix = sourceImsi.slice(-6);
  if (raw.endsWith(sourceSuffix)) return `${raw.slice(0, -sourceSuffix.length)}${targetImsi.slice(-6)}`;
  return raw;
}

export async function cloneOcsProvisioningFromReference(targetImsi: string, sourceImsi: string): Promise<void> {
  const now = new Date();
  const [subscriberCollection, balanceCollection] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
  ]);
  const [sourceSubscriber, sourceBalance] = await Promise.all([
    subscriberCollection.findOne({ imsi: sourceImsi }),
    balanceCollection.findOne({ imsi: sourceImsi }),
  ]);

  if (!sourceSubscriber || !sourceBalance) {
    throw new Error('REFERENCE_OCS_NOT_FOUND');
  }

  await Promise.all([
    subscriberCollection.replaceOne(
      { imsi: targetImsi },
      {
        imsi: targetImsi,
        msisdn: referencedMsisdn(sourceSubscriber.msisdn, sourceImsi, targetImsi),
        status: sourceSubscriber.status || 'active',
        plan_id: sourceSubscriber.plan_id || DEFAULT_OCS_PLAN_ID,
        created_at: now,
        updated_at: now,
      },
      { upsert: true }
    ),
    balanceCollection.replaceOne(
      { imsi: targetImsi },
      {
        imsi: targetImsi,
        data_total: sourceBalance.data_total,
        data_used: sourceBalance.data_used,
        data_reserved: sourceBalance.data_reserved,
        data_available: sourceBalance.data_available,
        version: sourceBalance.version,
        updated_at: now,
      },
      { upsert: true }
    ),
  ]);
}

export async function readOcsProvisioning(imsi: string) {
  const [subscriberCollection, balanceCollection, policy] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
    firstActiveRatingPolicy(),
  ]);
  const [subscriber, balance] = await Promise.all([
    subscriberCollection.findOne({ imsi }),
    balanceCollection.findOne({ imsi }),
  ]);

  return {
    subscriber,
    balance,
    policy,
    traffic: balance
      ? {
          traffic_total: toNumber(balance.data_total),
          traffic_balance: toNumber(balance.data_available),
          imsi,
          plmn: imsi.slice(0, 5),
        }
      : null,
    imsiSet: policy
      ? {
          rates_map: { [imsi.slice(0, 5)]: policy.rating_group_id },
          imsi,
        }
      : null,
  };
}

export async function readOcsProvisioningForImsis(imsis: string[]) {
  if (imsis.length === 0) {
    return {
      subscribers: new Map<string, OcsSubscriber>(),
      balances: new Map<string, OcsBalance>(),
      policy: null as RatingPolicy | null,
    };
  }

  const [subscriberCollection, balanceCollection, policy] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
    firstActiveRatingPolicy(),
  ]);
  const [subscribers, balances] = await Promise.all([
    subscriberCollection.find({ imsi: { $in: imsis } }).toArray(),
    balanceCollection.find({ imsi: { $in: imsis } }).toArray(),
  ]);

  return {
    subscribers: new Map(subscribers.map((subscriber) => [subscriber.imsi, subscriber])),
    balances: new Map(balances.map((balance) => [balance.imsi, balance])),
    policy,
  };
}
