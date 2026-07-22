import { Document, Long } from 'mongodb';
import { getAppCollection, getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import type { TrafficAdjustmentPayload } from '@/lib/subscriberValidation';

export const DEFAULT_OCS_PLAN_ID = 'plan_default_10gb';
const DEFAULT_QUOTA_PER_GRANT = 10 * 1024 * 1024;
const DEFAULT_VOLUME_THRESHOLD = 8 * 1024 * 1024;
const DEFAULT_VALIDITY_TIME = 300;
const DEFAULT_TOTAL_BALANCE = 10 * 1024 * 1024 * 1024;
const DEFAULT_VOICE_TOTAL = 60 * 60;
const DEFAULT_VOICE_QUOTA_PER_GRANT = 60;
const DEFAULT_SMS_TOTAL = 100;
const DEFAULT_SMS_QUOTA_PER_GRANT = 1;

export type OcsTariffRule = {
  rule_id: string;
  apn: string;
  rating_group: Long | number;
  service_identifier: Long | number;
  charging_type: 'data_volume' | 'free' | 'voice_time' | 'sms_event' | string;
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
  voice_total?: Long | number;
  voice_used?: Long | number;
  voice_reserved?: Long | number;
  voice_available?: Long | number;
  sms_total?: Long | number;
  sms_used?: Long | number;
  sms_available?: Long | number;
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
  voiceTotal?: unknown;
  voiceAvailable?: unknown;
  smsTotal?: unknown;
  smsAvailable?: unknown;
  status?: unknown;
};

export type OcsTrafficSnapshot = {
  imsi: string;
  traffic_total: number;
  traffic_balance: number;
  data_used: number;
  data_reserved: number;
  voice_total: number;
  voice_balance: number;
  voice_used: number;
  voice_reserved: number;
  sms_total: number;
  sms_balance: number;
  sms_used: number;
  version: number;
};

export type OcsTrafficAdjustmentResult = {
  mode: TrafficAdjustmentPayload['mode'];
  reason?: string;
  before: OcsTrafficSnapshot;
  after: OcsTrafficSnapshot;
};

export type OcsPolicyChangeInput = {
  imsiList: string[];
  planId: string;
  status: 'active' | 'suspended';
  resetBalances: boolean;
};

export type OcsPolicyChangeResult = {
  requested: number;
  subscriberModified: number;
  balanceModified: number;
  planId: string;
  status: 'active' | 'suspended';
  resetBalances: boolean;
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
  if (type === 1) return 'voice_time';
  if (type === 3) return 'sms_event';
  return 'data_volume';
}

function defaultGrantForChargingType(chargingType: string): number {
  if (chargingType === 'voice_time') return DEFAULT_VOICE_QUOTA_PER_GRANT;
  if (chargingType === 'sms_event') return DEFAULT_SMS_QUOTA_PER_GRANT;
  if (chargingType === 'free') return 0;
  return DEFAULT_QUOTA_PER_GRANT;
}

function defaultThresholdForChargingType(chargingType: string): number {
  if (chargingType === 'voice_time' || chargingType === 'sms_event' || chargingType === 'free') return 0;
  return DEFAULT_VOLUME_THRESHOLD;
}

function defaultValidityForChargingType(chargingType: string): number {
  if (chargingType === 'free' || chargingType === 'sms_event') return 0;
  return DEFAULT_VALIDITY_TIME;
}

function unitForChargingType(chargingType: string): string {
  if (chargingType === 'voice_time') return 'seconds';
  if (chargingType === 'sms_event') return 'events';
  return 'bytes';
}

function defaultInternetRule(): OcsTariffRule {
  return {
    rule_id: 'internet_rg1001_si1',
    apn: 'internet',
    rating_group: Long.fromNumber(1001),
    service_identifier: Long.fromNumber(1),
    charging_type: 'data_volume',
    unit: 'bytes',
    quota_per_grant: Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
    priority: 100,
    status: 'active',
  };
}

function defaultImsRule(): OcsTariffRule {
  return {
    rule_id: 'ims_default',
    apn: 'ims',
    rating_group: Long.ZERO,
    service_identifier: Long.ZERO,
    charging_type: 'free',
    unit: 'bytes',
    quota_per_grant: Long.ZERO,
    validity_time: 0,
    volume_threshold: Long.ZERO,
    priority: 200,
    status: 'active',
  };
}

function defaultVoiceRule(): OcsTariffRule {
  return {
    rule_id: 'voice_rg3001_si1',
    apn: 'ims',
    rating_group: Long.fromNumber(3001),
    service_identifier: Long.fromNumber(1),
    charging_type: 'voice_time',
    unit: 'seconds',
    quota_per_grant: Long.fromNumber(DEFAULT_VOICE_QUOTA_PER_GRANT),
    validity_time: DEFAULT_VALIDITY_TIME,
    volume_threshold: Long.ZERO,
    priority: 90,
    status: 'active',
  };
}

function defaultSmsRule(): OcsTariffRule {
  return {
    rule_id: 'sms_rg4001_si1',
    apn: 'ims',
    rating_group: Long.fromNumber(4001),
    service_identifier: Long.fromNumber(1),
    charging_type: 'sms_event',
    unit: 'events',
    quota_per_grant: Long.fromNumber(DEFAULT_SMS_QUOTA_PER_GRANT),
    validity_time: 0,
    volume_threshold: Long.ZERO,
    priority: 100,
    status: 'active',
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
    unit: 'bytes',
    rules: [defaultInternetRule(), defaultImsRule(), defaultVoiceRule(), defaultSmsRule()],
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

function tariffPlanSnapshot(plan: OcsTariffPlan | null) {
  if (!plan) return null;
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    rules: (plan.rules || []).map((rule) => normalizePolicy(rule, plan.plan_id)),
  };
}

function trafficSnapshot(
  imsi: string,
  balance: Pick<OcsBalance, 'data_total' | 'data_used' | 'data_reserved' | 'data_available' | 'voice_total' | 'voice_used' | 'voice_reserved' | 'voice_available' | 'sms_total' | 'sms_used' | 'sms_available' | 'version'>
): OcsTrafficSnapshot {
  const dataUsed = Math.max(0, toNumber(balance.data_used));
  const dataReserved = Math.max(0, toNumber(balance.data_reserved));
  const dataAvailable = Math.max(0, toNumber(balance.data_available));
  const dataTotal = Math.max(toNumber(balance.data_total), dataUsed + dataReserved + dataAvailable);
  const voiceUsed = Math.max(0, toNumber(balance.voice_used));
  const voiceReserved = Math.max(0, toNumber(balance.voice_reserved));
  const voiceAvailable = Math.max(0, toNumber(balance.voice_available));
  const voiceTotal = Math.max(toNumber(balance.voice_total), voiceUsed + voiceReserved + voiceAvailable);
  const smsUsed = Math.max(0, toNumber(balance.sms_used));
  const smsAvailable = Math.max(0, toNumber(balance.sms_available));
  const smsTotal = Math.max(toNumber(balance.sms_total), smsUsed + smsAvailable);

  return {
    imsi,
    traffic_total: dataTotal,
    traffic_balance: dataAvailable,
    data_used: dataUsed,
    data_reserved: dataReserved,
    voice_total: voiceTotal,
    voice_balance: voiceAvailable,
    voice_used: voiceUsed,
    voice_reserved: voiceReserved,
    sms_total: smsTotal,
    sms_balance: smsAvailable,
    sms_used: smsUsed,
    version: toNumber(balance.version, 0),
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
  const unit = unitForChargingType(chargingType);

  return {
    rule_id: `${apn}_rg${ratingGroupId}_si${serviceIdentifier}`,
    apn,
    rating_group: Long.fromNumber(ratingGroupId),
    service_identifier: Long.fromNumber(serviceIdentifier),
    charging_type: chargingType,
    unit,
    quota_per_grant: toLong(input.quota_per_grant, defaultGrantForChargingType(chargingType)),
    validity_time: Number(input.validity_time ?? defaultValidityForChargingType(chargingType)),
    volume_threshold: toLong(input.volume_threshold, defaultThresholdForChargingType(chargingType)),
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
  let rules = [...(plan.rules || [])];
  let changed = false;

  if (!rules.some((rule) => rule.rule_id === 'internet_rg1001_si1')) {
    rules = [defaultInternetRule(), ...rules];
    changed = true;
  }

  if (!rules.some((rule) => rule.rule_id === 'ims_default')) {
    rules.push(defaultImsRule());
    changed = true;
  }

  if (!rules.some((rule) => rule.rule_id === 'voice_rg3001_si1')) {
    rules.push(defaultVoiceRule());
    changed = true;
  }

  if (!rules.some((rule) => rule.rule_id === 'sms_rg4001_si1')) {
    rules.push(defaultSmsRule());
    changed = true;
  }

  const legacyCollection = await legacyRatingsCollection();
  const legacyRatings = await legacyCollection
    .find({ rating_group_id: { $exists: true } })
    .sort({ rating_group_id: 1 })
    .toArray();
  if (legacyRatings.length === 0 && !changed) return plan;

  const existingRatingGroups = new Set(rules.map((rule) => toNumber(rule.rating_group)));
  const importedRules = legacyRatings
    .filter((rating) => Number.isFinite(Number(rating.rating_group_id)))
    .filter((rating) => !existingRatingGroups.has(Number(rating.rating_group_id)))
    .map((rating) => makeRule({
      rating_group_id: rating.rating_group_id,
      currency: rating.currency,
      rates: rating.rates,
      rates_type: rating.rates_type,
    }));
  if (importedRules.length > 0) changed = true;
  if (!changed) return plan;

  const next = {
    ...plan,
    rules: [...rules, ...importedRules],
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
  const voiceTotalInput = input.voiceTotal ?? existingBalance?.voice_total ?? DEFAULT_VOICE_TOTAL;
  const voiceTotal = toNumber(voiceTotalInput, DEFAULT_VOICE_TOTAL);
  const hasVoiceAvailableInput = input.voiceAvailable !== undefined && input.voiceAvailable !== null && input.voiceAvailable !== '';
  const requestedVoiceAvailable = toNumber(input.voiceAvailable ?? existingBalance?.voice_available, voiceTotal);
  const voiceAvailable = Math.min(Math.max(0, requestedVoiceAvailable), voiceTotal);
  const voiceReserved = hasVoiceAvailableInput
    ? 0
    : existingBalance
    ? toNumber(existingBalance.voice_reserved)
    : 0;
  const voiceUsed = hasVoiceAvailableInput
    ? Math.max(0, voiceTotal - voiceReserved - voiceAvailable)
    : existingBalance
    ? toNumber(existingBalance.voice_used)
    : Math.max(0, voiceTotal - voiceReserved - voiceAvailable);
  const nextVoiceTotal = Math.max(voiceTotal, voiceUsed + voiceReserved + voiceAvailable);
  const smsTotalInput = input.smsTotal ?? existingBalance?.sms_total ?? DEFAULT_SMS_TOTAL;
  const smsTotal = toNumber(smsTotalInput, DEFAULT_SMS_TOTAL);
  const hasSmsAvailableInput = input.smsAvailable !== undefined && input.smsAvailable !== null && input.smsAvailable !== '';
  const requestedSmsAvailable = toNumber(input.smsAvailable ?? existingBalance?.sms_available, smsTotal);
  const smsAvailable = Math.min(Math.max(0, requestedSmsAvailable), smsTotal);
  const smsUsed = hasSmsAvailableInput
    ? Math.max(0, smsTotal - smsAvailable)
    : existingBalance
    ? toNumber(existingBalance.sms_used)
    : Math.max(0, smsTotal - smsAvailable);
  const nextSmsTotal = Math.max(smsTotal, smsUsed + smsAvailable);
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
        voice_total: Long.fromNumber(nextVoiceTotal),
        voice_used: Long.fromNumber(voiceUsed),
        voice_reserved: Long.fromNumber(voiceReserved),
        voice_available: Long.fromNumber(voiceAvailable),
        sms_total: Long.fromNumber(nextSmsTotal),
        sms_used: Long.fromNumber(smsUsed),
        sms_available: Long.fromNumber(smsAvailable),
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

export async function adjustOcsTrafficBalance(
  imsi: string,
  input: TrafficAdjustmentPayload
): Promise<OcsTrafficAdjustmentResult> {
  const collection = await ocsBalancesCollection();
  const existingBalance = await collection.findOne({ imsi });

  if (!existingBalance) {
    throw new Error('OCS_BALANCE_NOT_FOUND');
  }

  const before = trafficSnapshot(imsi, existingBalance);
  let nextTotal = before.traffic_total;
  let nextUsed = before.data_used;
  let nextReserved = before.data_reserved;
  let nextAvailable = before.traffic_balance;

  if (input.mode === 'recharge') {
    const amount = Number(input.amount || 0);
    nextTotal += amount;
    nextAvailable += amount;
  } else if (input.mode === 'set_available') {
    nextAvailable = Number(input.value || 0);
    nextTotal = Math.max(nextTotal, nextUsed + nextReserved + nextAvailable);
  } else if (input.mode === 'set_total') {
    const requestedTotal = Number(input.value || 0);
    if (requestedTotal < nextUsed + nextReserved) {
      throw new Error('OCS_TOTAL_BELOW_COMMITTED');
    }
    nextTotal = requestedTotal;
    nextAvailable = Math.min(nextAvailable, Math.max(0, nextTotal - nextUsed - nextReserved));
  } else if (input.mode === 'reset') {
    nextUsed = 0;
    nextReserved = 0;
    nextAvailable = nextTotal;
  }

  const nextVersion = before.version + 1;
  const versionFilter = existingBalance.version === undefined
    ? { version: { $exists: false } }
    : { version: existingBalance.version };
  const updateResult = await collection.updateOne(
    { imsi, ...versionFilter },
    {
      $set: {
        data_total: Long.fromNumber(nextTotal),
        data_used: Long.fromNumber(nextUsed),
        data_reserved: Long.fromNumber(nextReserved),
        data_available: Long.fromNumber(nextAvailable),
        version: Long.fromNumber(nextVersion),
        updated_at: new Date(),
      },
    }
  );

  if (updateResult.matchedCount === 0) {
    throw new Error('OCS_BALANCE_CONFLICT');
  }

  return {
    mode: input.mode,
    reason: input.reason,
    before,
    after: {
      imsi,
      traffic_total: nextTotal,
      traffic_balance: nextAvailable,
      data_used: nextUsed,
      data_reserved: nextReserved,
      voice_total: before.voice_total,
      voice_balance: before.voice_balance,
      voice_used: before.voice_used,
      voice_reserved: before.voice_reserved,
      sms_total: before.sms_total,
      sms_balance: before.sms_balance,
      sms_used: before.sms_used,
      version: nextVersion,
    },
  };
}

export async function changeOcsPolicyForSubscribers(input: OcsPolicyChangeInput): Promise<OcsPolicyChangeResult> {
  const now = new Date();
  const planId = asString(input.planId, DEFAULT_OCS_PLAN_ID);
  const [tariffPlans, subscriberCollection, balanceCollection] = await Promise.all([
    tariffPlansCollection(),
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
  ]);
  const plan = planId === DEFAULT_OCS_PLAN_ID
    ? await getOrCreateDefaultPlan()
    : await tariffPlans.findOne({ plan_id: planId });

  if (!plan) {
    throw new Error('OCS_PLAN_NOT_FOUND');
  }

  const uniqueImsis = Array.from(new Set(input.imsiList));
  const existingBalances = await balanceCollection
    .find({ imsi: { $in: uniqueImsis } })
    .toArray();
  const balanceByImsi = new Map(existingBalances.map((balance) => [balance.imsi, balance]));

  const subscriberResult = await subscriberCollection.bulkWrite(
    uniqueImsis.map((imsi) => ({
      updateOne: {
        filter: { imsi },
        update: {
          $set: {
            plan_id: planId,
            status: input.status,
            updated_at: now,
          },
          $setOnInsert: {
            imsi,
            msisdn: '',
            created_at: now,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  const balanceResult = await balanceCollection.bulkWrite(
    uniqueImsis.map((imsi) => {
      const existing = balanceByImsi.get(imsi);
      const dataTotal = Math.max(toNumber(existing?.data_total, DEFAULT_TOTAL_BALANCE), 0);
      const voiceTotal = Math.max(toNumber(existing?.voice_total, DEFAULT_VOICE_TOTAL), 0);
      const smsTotal = Math.max(toNumber(existing?.sms_total, DEFAULT_SMS_TOTAL), 0);
      const version = toNumber(existing?.version, 0) + 1;
      const setPayload: Record<string, unknown> = {
        plan_id: planId,
        status: input.status,
        version: Long.fromNumber(version),
        updated_at: now,
      };

      if (input.resetBalances || !existing) {
        setPayload.data_total = Long.fromNumber(dataTotal);
        setPayload.data_used = Long.ZERO;
        setPayload.data_reserved = Long.ZERO;
        setPayload.data_available = Long.fromNumber(dataTotal);
        setPayload.voice_total = Long.fromNumber(voiceTotal);
        setPayload.voice_used = Long.ZERO;
        setPayload.voice_reserved = Long.ZERO;
        setPayload.voice_available = Long.fromNumber(voiceTotal);
        setPayload.sms_total = Long.fromNumber(smsTotal);
        setPayload.sms_used = Long.ZERO;
        setPayload.sms_available = Long.fromNumber(smsTotal);
        setPayload.money_balance = Long.ZERO;
        setPayload.cycle_start_at = now;
        setPayload.cycle_reset_at = now;
      }

      return {
        updateOne: {
          filter: { imsi },
          update: {
            $set: setPayload,
            $setOnInsert: {
              imsi,
              created_at: now,
            },
          },
          upsert: true,
        },
      };
    }),
    { ordered: false }
  );

  return {
    requested: uniqueImsis.length,
    subscriberModified: subscriberResult.modifiedCount + subscriberResult.upsertedCount,
    balanceModified: balanceResult.modifiedCount + balanceResult.upsertedCount,
    planId,
    status: input.status,
    resetBalances: input.resetBalances,
  };
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
        voice_total: sourceBalance.voice_total ?? Long.fromNumber(DEFAULT_VOICE_TOTAL),
        voice_used: sourceBalance.voice_used ?? Long.ZERO,
        voice_reserved: sourceBalance.voice_reserved ?? Long.ZERO,
        voice_available: sourceBalance.voice_available ?? sourceBalance.voice_total ?? Long.fromNumber(DEFAULT_VOICE_TOTAL),
        sms_total: sourceBalance.sms_total ?? Long.fromNumber(DEFAULT_SMS_TOTAL),
        sms_used: sourceBalance.sms_used ?? Long.ZERO,
        sms_available: sourceBalance.sms_available ?? sourceBalance.sms_total ?? Long.fromNumber(DEFAULT_SMS_TOTAL),
        money_balance: sourceBalance.money_balance ?? Long.ZERO,
        plan_id: sourceBalance.plan_id || sourceSubscriber.plan_id || DEFAULT_OCS_PLAN_ID,
        status: sourceBalance.status || sourceSubscriber.status || 'active',
        version: sourceBalance.version,
        created_at: now,
        updated_at: now,
        cycle_start_at: sourceBalance.cycle_start_at || now,
        cycle_reset_at: sourceBalance.cycle_reset_at || now,
      },
      { upsert: true }
    ),
  ]);
}

export async function readOcsProvisioning(imsi: string) {
  const [subscriberCollection, balanceCollection, policy, defaultPlan] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
    firstActiveRatingPolicy(),
    getOrCreateDefaultPlan(),
  ]);
  const [subscriber, balance] = await Promise.all([
    subscriberCollection.findOne({ imsi }),
    balanceCollection.findOne({ imsi }),
  ]);
  const plan = subscriber?.plan_id && subscriber.plan_id !== defaultPlan.plan_id
    ? await (await tariffPlansCollection()).findOne({ plan_id: subscriber.plan_id })
    : defaultPlan;

  return {
    subscriber,
    balance,
    policy,
    tariffPlan: tariffPlanSnapshot(plan),
    traffic: balance
      ? {
          traffic_total: toNumber(balance.data_total),
          traffic_balance: toNumber(balance.data_available),
          data_used: toNumber(balance.data_used),
          data_reserved: toNumber(balance.data_reserved),
          voice_total: toNumber(balance.voice_total, DEFAULT_VOICE_TOTAL),
          voice_balance: toNumber(balance.voice_available, DEFAULT_VOICE_TOTAL),
          voice_used: toNumber(balance.voice_used),
          voice_reserved: toNumber(balance.voice_reserved),
          sms_total: toNumber(balance.sms_total, DEFAULT_SMS_TOTAL),
          sms_balance: toNumber(balance.sms_available, DEFAULT_SMS_TOTAL),
          sms_used: toNumber(balance.sms_used),
          imsi,
          plmn: imsi.slice(0, 5),
        }
      : null,
    imsiSet: null,
  };
}

export async function readOcsProvisioningForImsis(imsis: string[]) {
  if (imsis.length === 0) {
    return {
      subscribers: new Map<string, OcsSubscriber>(),
      balances: new Map<string, OcsBalance>(),
    };
  }

  const [subscriberCollection, balanceCollection] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
  ]);
  const [subscribers, balances] = await Promise.all([
    subscriberCollection.find({ imsi: { $in: imsis } }).toArray(),
    balanceCollection.find({ imsi: { $in: imsis } }).toArray(),
  ]);

  return {
    subscribers: new Map(subscribers.map((subscriber) => [subscriber.imsi, subscriber])),
    balances: new Map(balances.map((balance) => [balance.imsi, balance])),
  };
}
