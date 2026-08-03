import { Document, Long } from 'mongodb';
import { getAppCollection, getOpen5gsCollection, mongoCollections } from '@/lib/mongo';
import type { TrafficAdjustmentPayload } from '@/lib/subscriberValidation';
import {
  DEFAULT_OCS_PLAN_ID,
  buildTariffPlanOperationsSummary,
  isDefaultTariffPlan,
  isValidTariffPlanId,
  shouldBlockTariffPlanDisable,
} from '@/lib/tariffPlanOperations';

export {
  DEFAULT_OCS_PLAN_ID,
  buildTariffPlanOperationsSummary,
  isDefaultTariffPlan,
  isValidTariffPlanId,
  shouldBlockTariffPlanDisable,
};
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
  name?: string;
  description?: string;
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

export type TariffPlanSummary = {
  plan_id: string;
  name: string;
  description: string;
  status: string;
  quota_per_grant?: number;
  validity_time?: number;
  volume_threshold?: number;
  rulesCount: number;
  subscriberCount: number;
  isDefault: boolean;
  created_at?: Date | string;
  updated_at?: Date | string;
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

export type TariffPlanSubscriberSummary = {
  imsi: string;
  msisdn?: string;
  status?: string;
  updated_at?: Date | string;
};

export type TariffPlanMigrationInput = {
  sourcePlanId: unknown;
  targetPlanId: unknown;
  resetBalances?: boolean;
};

export type TariffPlanMigrationResult = {
  requested: number;
  subscriberModified: number;
  balanceModified: number;
  sourcePlanId: string;
  targetPlanId: string;
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

function normalizePlanId(value: unknown, fallback = DEFAULT_OCS_PLAN_ID): string {
  const planId = asString(value, fallback).trim();
  if (!isValidTariffPlanId(planId)) {
    throw new Error('INVALID_PLAN_ID');
  }
  return planId;
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

function defaultPlan(
  now = new Date(),
  planId = DEFAULT_OCS_PLAN_ID,
  name = 'Default 10GB Data Plan',
  description = ''
): OcsTariffPlan {
  return {
    plan_id: planId,
    name,
    description,
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
    name: asString(plan.name, plan.plan_id),
    description: asString(plan.description),
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

async function getTariffPlanDocument(planIdInput?: unknown): Promise<OcsTariffPlan | null> {
  const planId = normalizePlanId(planIdInput);
  if (planId === DEFAULT_OCS_PLAN_ID) return getOrCreateDefaultPlan();
  const collection = await tariffPlansCollection();
  return collection.findOne({ plan_id: planId });
}

function summarizePlan(plan: OcsTariffPlan, subscriberCount: number): TariffPlanSummary {
  return {
    plan_id: plan.plan_id,
    name: asString(plan.name, plan.plan_id),
    description: asString(plan.description),
    status: plan.status || 'active',
    quota_per_grant: toNumber(plan.quota_per_grant, DEFAULT_QUOTA_PER_GRANT),
    validity_time: toNumber(plan.validity_time, DEFAULT_VALIDITY_TIME),
    volume_threshold: toNumber(plan.volume_threshold, DEFAULT_VOLUME_THRESHOLD),
    rulesCount: (plan.rules || []).length,
    subscriberCount,
    isDefault: plan.plan_id === DEFAULT_OCS_PLAN_ID,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
  };
}

export async function listTariffPlans(): Promise<TariffPlanSummary[]> {
  await getOrCreateDefaultPlan();
  const [plansCollection, subscribersCollection] = await Promise.all([
    tariffPlansCollection(),
    ocsSubscribersCollection(),
  ]);
  const plans = await plansCollection.find({}).sort({ plan_id: 1 }).toArray();
  const subscriberCounts = await Promise.all(
    plans.map((plan) => subscribersCollection.countDocuments({ plan_id: plan.plan_id }))
  );

  return plans.map((plan, index) => summarizePlan(plan, subscriberCounts[index] || 0));
}

export async function getTariffPlan(planIdInput?: unknown) {
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) return null;
  const subscribersCollection = await ocsSubscribersCollection();
  const subscriberCount = await subscribersCollection.countDocuments({ plan_id: plan.plan_id });
  return {
    ...summarizePlan(plan, subscriberCount),
    rules: (plan.rules || []).map((rule) => normalizePolicy(rule, plan.plan_id)),
  };
}

export async function createTariffPlan(input: {
  plan_id?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  quota_per_grant?: unknown;
  validity_time?: unknown;
  volume_threshold?: unknown;
  rules?: unknown[];
  cloneFromPlanId?: unknown;
}): Promise<TariffPlanSummary> {
  const planId = normalizePlanId(input.plan_id);
  const collection = await tariffPlansCollection();
  const existing = await collection.findOne({ plan_id: planId });
  if (existing) throw new Error('TARIFF_PLAN_EXISTS');

  const now = new Date();
  const sourcePlan = input.cloneFromPlanId ? await getTariffPlanDocument(input.cloneFromPlanId) : null;
  if (input.cloneFromPlanId && !sourcePlan) throw new Error('SOURCE_TARIFF_PLAN_NOT_FOUND');

  let initialRules: OcsTariffRule[];
  if (sourcePlan) {
    initialRules = (sourcePlan.rules || []).map((r) => ({ ...r }));
  } else if (Array.isArray(input.rules) && input.rules.length > 0) {
    initialRules = input.rules.map((r: any) => ({
      rule_id: asString(r.rule_id),
      apn: asString(r.apn, 'internet'),
      rating_group: toLong(r.rating_group, 0),
      service_identifier: toLong(r.service_identifier, 0),
      charging_type: asString(r.charging_type, 'data_volume'),
      unit: asString(r.unit, 'bytes'),
      quota_per_grant: toLong(r.quota_per_grant, DEFAULT_QUOTA_PER_GRANT),
      validity_time: Number(r.validity_time) || 0,
      volume_threshold: toLong(r.volume_threshold, DEFAULT_VOLUME_THRESHOLD),
      priority: Number(r.priority) || 100,
      status: asString(r.status, 'active'),
      currency: asString(r.currency, 'USD'),
      rates: asString(r.rates, '0'),
      rates_type: Number(r.rates_type) || 2,
    }));
  } else {
    initialRules = [defaultInternetRule(), defaultImsRule(), defaultVoiceRule(), defaultSmsRule()];
  }

  const plan: OcsTariffPlan = {
    plan_id: planId,
    name: asString(input.name, sourcePlan ? `${asString(sourcePlan.name, sourcePlan.plan_id)} Copy` : planId),
    description: asString(input.description, sourcePlan ? asString(sourcePlan.description) : ''),
    status: asString(input.status, 'active'),
    quota_per_grant: input.quota_per_grant !== undefined
      ? toLong(input.quota_per_grant, DEFAULT_QUOTA_PER_GRANT)
      : (sourcePlan?.quota_per_grant ?? Long.fromNumber(DEFAULT_QUOTA_PER_GRANT)),
    validity_time: input.validity_time !== undefined
      ? Number(input.validity_time) || 0
      : (sourcePlan?.validity_time ?? DEFAULT_VALIDITY_TIME),
    volume_threshold: input.volume_threshold !== undefined
      ? toLong(input.volume_threshold, DEFAULT_VOLUME_THRESHOLD)
      : (sourcePlan?.volume_threshold ?? Long.fromNumber(DEFAULT_VOLUME_THRESHOLD)),
    rules: initialRules,
    created_at: now,
    updated_at: now,
  };

  delete (plan as { _id?: unknown })._id;
  await collection.insertOne(plan);
  return summarizePlan(plan, 0);
}

export async function cloneTariffPlan(
  sourcePlanIdInput: unknown,
  newPlanIdInput: unknown,
  newNameInput?: unknown,
  newDescriptionInput?: unknown
): Promise<TariffPlanSummary> {
  const sourcePlanId = normalizePlanId(sourcePlanIdInput);
  const newPlanId = normalizePlanId(newPlanIdInput);
  if (sourcePlanId === newPlanId) throw new Error('SOURCE_AND_TARGET_SAME');

  const collection = await tariffPlansCollection();
  const existing = await collection.findOne({ plan_id: newPlanId });
  if (existing) throw new Error('TARIFF_PLAN_EXISTS');

  const sourcePlan = await getTariffPlanDocument(sourcePlanId);
  if (!sourcePlan) throw new Error('SOURCE_TARIFF_PLAN_NOT_FOUND');

  const now = new Date();
  const clonedRules = (sourcePlan.rules || []).map((r) => ({ ...r }));

  const cloned: OcsTariffPlan = {
    plan_id: newPlanId,
    name: asString(newNameInput, `${asString(sourcePlan.name, sourcePlan.plan_id)} Copy`),
    description: asString(newDescriptionInput, asString(sourcePlan.description)),
    status: 'active',
    quota_per_grant: sourcePlan.quota_per_grant ?? Long.fromNumber(DEFAULT_QUOTA_PER_GRANT),
    validity_time: sourcePlan.validity_time ?? DEFAULT_VALIDITY_TIME,
    volume_threshold: sourcePlan.volume_threshold ?? Long.fromNumber(DEFAULT_VOLUME_THRESHOLD),
    rules: clonedRules,
    created_at: now,
    updated_at: now,
  };

  await collection.insertOne(cloned);
  return summarizePlan(cloned, 0);
}

export async function updateTariffPlan(planIdInput: unknown, input: {
  name?: unknown;
  description?: unknown;
  status?: unknown;
  quota_per_grant?: unknown;
  validity_time?: unknown;
  volume_threshold?: unknown;
  rules?: unknown[];
}): Promise<TariffPlanSummary | null> {
  const planId = normalizePlanId(planIdInput);
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planId);
  if (!plan) return null;
  const subscribersCollection = await ocsSubscribersCollection();
  const subscriberCount = await subscribersCollection.countDocuments({ plan_id: planId });
  const nextStatus = input.status === undefined ? plan.status : asString(input.status, 'active');
  if (shouldBlockTariffPlanDisable(plan.status, nextStatus, subscriberCount)) {
    throw new Error('TARIFF_PLAN_DISABLE_IN_USE');
  }

  let nextRules = plan.rules || [];
  if (Array.isArray(input.rules)) {
    nextRules = input.rules.map((r: any) => {
      const ratingGroupId = Number(r.rating_group_id ?? r.rating_group ?? 0);
      const serviceIdentifier = Number(r.service_identifier ?? 1);
      const apn = asString(r.apn, 'internet');
      const ruleId = asString(r.rule_id, `${apn}_rg${ratingGroupId}_si${serviceIdentifier}`);
      const chargingType = asString(r.charging_type, ratesTypeToChargingType(r.rates_type));
      const unit = asString(r.unit, unitForChargingType(chargingType));

      return {
        rule_id: ruleId,
        apn,
        rating_group: toLong(ratingGroupId, 0),
        service_identifier: toLong(serviceIdentifier, 0),
        charging_type: chargingType,
        unit,
        quota_per_grant: toLong(r.quota_per_grant, defaultGrantForChargingType(chargingType)),
        validity_time: Number(r.validity_time ?? defaultValidityForChargingType(chargingType)),
        volume_threshold: toLong(r.volume_threshold, defaultThresholdForChargingType(chargingType)),
        priority: Number(r.priority ?? 100),
        status: asString(r.status, 'active'),
        currency: asString(r.currency, 'USD'),
        rates: asString(r.rates, '0'),
        rates_type: Number(r.rates_type) || 2,
      };
    });
  }

  const next: OcsTariffPlan = {
    ...plan,
    name: input.name === undefined ? plan.name : asString(input.name, plan.plan_id),
    description: input.description === undefined ? plan.description : asString(input.description),
    status: nextStatus,
    quota_per_grant: input.quota_per_grant !== undefined
      ? toLong(input.quota_per_grant, DEFAULT_QUOTA_PER_GRANT)
      : (plan.quota_per_grant ?? Long.fromNumber(DEFAULT_QUOTA_PER_GRANT)),
    validity_time: input.validity_time !== undefined
      ? Number(input.validity_time) || 0
      : (plan.validity_time ?? DEFAULT_VALIDITY_TIME),
    volume_threshold: input.volume_threshold !== undefined
      ? toLong(input.volume_threshold, DEFAULT_VOLUME_THRESHOLD)
      : (plan.volume_threshold ?? Long.fromNumber(DEFAULT_VOLUME_THRESHOLD)),
    rules: nextRules,
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: planId }, next);
  return summarizePlan(next, subscriberCount);
}

export async function dryRunMigrateTariffPlanSubscribers(sourcePlanIdInput: unknown, targetPlanIdInput: unknown) {
  const sourcePlanId = normalizePlanId(sourcePlanIdInput);
  const targetPlanId = normalizePlanId(targetPlanIdInput);
  if (sourcePlanId === targetPlanId) throw new Error('TARIFF_PLAN_MIGRATE_SAME');

  const [subscriberCollection, sourcePlan, targetPlan] = await Promise.all([
    ocsSubscribersCollection(),
    getTariffPlanDocument(sourcePlanId),
    getTariffPlanDocument(targetPlanId),
  ]);

  if (!sourcePlan) throw new Error('SOURCE_PLAN_NOT_FOUND');
  if (!targetPlan) throw new Error('TARGET_PLAN_NOT_FOUND');

  const total = await subscriberCollection.countDocuments({ plan_id: sourcePlanId });
  const activeCount = await subscriberCollection.countDocuments({ plan_id: sourcePlanId, status: 'active' });
  const suspendedCount = total - activeCount;

  return {
    sourcePlanId,
    sourcePlanName: sourcePlan.name || sourcePlanId,
    targetPlanId,
    targetPlanName: targetPlan.name || targetPlanId,
    targetPlanStatus: targetPlan.status || 'active',
    totalSubscribers: total,
    activeSubscribers: activeCount,
    suspendedSubscribers: suspendedCount,
    canMigrate: total > 0 && targetPlan.status !== 'disabled',
  };
}

export async function deleteTariffPlan(planIdInput: unknown) {
  const planId = normalizePlanId(planIdInput);
  if (isDefaultTariffPlan(planId)) throw new Error('DEFAULT_TARIFF_PLAN_PROTECTED');

  const [collection, subscribersCollection] = await Promise.all([
    tariffPlansCollection(),
    ocsSubscribersCollection(),
  ]);
  const subscriberExamples = await subscribersCollection
    .find({ plan_id: planId })
    .project<{ imsi: string }>({ imsi: 1, _id: 0 })
    .limit(5)
    .toArray();
  const subscriberCount = await subscribersCollection.countDocuments({ plan_id: planId });
  if (subscriberCount > 0) {
    return {
      deleted: false,
      references: {
        count: subscriberCount,
        examples: subscriberExamples.map((item) => item.imsi),
      },
    };
  }

  const result = await collection.deleteOne({ plan_id: planId });
  return {
    deleted: result.deletedCount > 0,
    references: { count: 0, examples: [] as string[] },
  };
}

export async function listTariffPlanSubscribers(planIdInput: unknown, limitInput = 20) {
  const planId = normalizePlanId(planIdInput);
  const subscribersCollection = await ocsSubscribersCollection();
  const limit = Math.min(Math.max(Number(limitInput) || 20, 1), 100);
  const [total, subscribers] = await Promise.all([
    subscribersCollection.countDocuments({ plan_id: planId }),
    subscribersCollection
      .find({ plan_id: planId })
      .project<TariffPlanSubscriberSummary>({ imsi: 1, msisdn: 1, status: 1, updated_at: 1, _id: 0 })
      .sort({ imsi: 1 })
      .limit(limit)
      .toArray(),
  ]);

  return {
    total,
    subscribers,
    hasMore: total > subscribers.length,
  };
}

export async function migrateTariffPlanSubscribers(input: TariffPlanMigrationInput): Promise<TariffPlanMigrationResult> {
  const sourcePlanId = normalizePlanId(input.sourcePlanId);
  const targetPlanId = normalizePlanId(input.targetPlanId);
  if (sourcePlanId === targetPlanId) throw new Error('TARIFF_PLAN_MIGRATE_SAME');

  const [subscriberCollection, balanceCollection] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
  ]);
  const [sourcePlan, targetPlan] = await Promise.all([
    getTariffPlanDocument(sourcePlanId),
    getTariffPlanDocument(targetPlanId),
  ]);
  if (!sourcePlan || !targetPlan) throw new Error('OCS_PLAN_NOT_FOUND');
  if (targetPlan.status === 'disabled') throw new Error('OCS_PLAN_DISABLED');

  const subscribers = await subscriberCollection.find({ plan_id: sourcePlanId }).toArray();
  const imsis = subscribers.map((subscriber) => subscriber.imsi);
  if (imsis.length === 0) {
    return {
      requested: 0,
      subscriberModified: 0,
      balanceModified: 0,
      sourcePlanId,
      targetPlanId,
      resetBalances: input.resetBalances === true,
    };
  }

  const now = new Date();
  const subscriberResult = await subscriberCollection.updateMany(
    { plan_id: sourcePlanId },
    { $set: { plan_id: targetPlanId, updated_at: now } }
  );

  let balanceModified = 0;
  if (input.resetBalances === true) {
    const balances = await balanceCollection.find({ imsi: { $in: imsis } }).toArray();
    if (balances.length > 0) {
      const balanceResult = await balanceCollection.bulkWrite(
        balances.map((balance) => {
          const dataTotal = Math.max(toNumber(balance.data_total, DEFAULT_TOTAL_BALANCE), 0);
          const voiceTotal = Math.max(toNumber(balance.voice_total, DEFAULT_VOICE_TOTAL), 0);
          const smsTotal = Math.max(toNumber(balance.sms_total, DEFAULT_SMS_TOTAL), 0);
          const version = toNumber(balance.version, 0) + 1;

          return {
            updateOne: {
              filter: { imsi: balance.imsi },
              update: {
                $set: {
                  plan_id: targetPlanId,
                  data_total: Long.fromNumber(dataTotal),
                  data_used: Long.ZERO,
                  data_reserved: Long.ZERO,
                  data_available: Long.fromNumber(dataTotal),
                  voice_total: Long.fromNumber(voiceTotal),
                  voice_used: Long.ZERO,
                  voice_reserved: Long.ZERO,
                  voice_available: Long.fromNumber(voiceTotal),
                  sms_total: Long.fromNumber(smsTotal),
                  sms_used: Long.ZERO,
                  sms_available: Long.fromNumber(smsTotal),
                  version: Long.fromNumber(version),
                  updated_at: now,
                  cycle_start_at: now,
                  cycle_reset_at: now,
                },
              },
            },
          };
        }),
        { ordered: false }
      );
      balanceModified = balanceResult.modifiedCount + balanceResult.upsertedCount;
    }
  } else {
    const balanceResult = await balanceCollection.updateMany(
      { imsi: { $in: imsis } },
      { $set: { plan_id: targetPlanId, updated_at: now } }
    );
    balanceModified = balanceResult.modifiedCount;
  }

  return {
    requested: imsis.length,
    subscriberModified: subscriberResult.modifiedCount,
    balanceModified,
    sourcePlanId,
    targetPlanId,
    resetBalances: input.resetBalances === true,
  };
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

export async function listRatingPolicies(planId?: unknown): Promise<RatingPolicy[]> {
  const plan = await getTariffPlanDocument(planId);
  if (!plan) return [];
  return nonSystemRules(plan)
    .map((rule) => normalizePolicy(rule, plan.plan_id))
    .sort((a, b) => a.rating_group_id - b.rating_group_id);
}

export async function getRatingPolicy(id: string | number, planId?: unknown): Promise<RatingPolicy | null> {
  const plan = await getTariffPlanDocument(planId);
  if (!plan) return null;
  const rule = nonSystemRules(plan).find((item) => String(toNumber(item.rating_group)) === String(id));
  return rule ? normalizePolicy(rule, plan.plan_id) : null;
}

export async function createRatingPolicy(input: Parameters<typeof makeRule>[0], planIdInput?: unknown): Promise<RatingPolicy> {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
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
  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return normalizePolicy(rule, plan.plan_id);
}

export async function updateRatingPolicy(id: string | number, input: Partial<Parameters<typeof makeRule>[0]>, planIdInput?: unknown): Promise<RatingPolicy> {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
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

  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return normalizePolicy(replacement, plan.plan_id);
}

export async function deleteRatingPolicy(id: string | number, planIdInput?: unknown) {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
  const ratingGroupId = Number(id);
  const before = plan.rules || [];
  const next = {
    ...plan,
    rules: before.filter((rule) => toNumber(rule.rating_group) !== ratingGroupId),
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return { deleted: before.length !== next.rules.length, references: { count: 0, examples: [] as string[] } };
}

export async function addTariffPlanRule(planIdInput: unknown, ruleInput: any) {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');

  const ratingGroupId = Number(ruleInput.rating_group_id ?? ruleInput.rating_group ?? 0);
  const serviceIdentifier = Number(ruleInput.service_identifier ?? 1);
  const apn = asString(ruleInput.apn, 'internet');
  const ruleId = asString(ruleInput.rule_id, `${apn}_rg${ratingGroupId}_si${serviceIdentifier}`);

  if ((plan.rules || []).some((r) => r.rule_id === ruleId)) {
    throw new Error('RULE_ID_EXISTS');
  }

  const chargingType = asString(ruleInput.charging_type, ratesTypeToChargingType(ruleInput.rates_type));
  const unit = asString(ruleInput.unit, unitForChargingType(chargingType));

  const newRule: OcsTariffRule = {
    rule_id: ruleId,
    apn,
    rating_group: toLong(ratingGroupId, 0),
    service_identifier: toLong(serviceIdentifier, 0),
    charging_type: chargingType,
    unit,
    quota_per_grant: toLong(ruleInput.quota_per_grant, defaultGrantForChargingType(chargingType)),
    validity_time: Number(ruleInput.validity_time ?? defaultValidityForChargingType(chargingType)),
    volume_threshold: toLong(ruleInput.volume_threshold, defaultThresholdForChargingType(chargingType)),
    priority: Number(ruleInput.priority ?? 100),
    status: asString(ruleInput.status, 'active'),
    currency: asString(ruleInput.currency, 'USD'),
    rates: asString(ruleInput.rates, '0'),
    rates_type: Number(ruleInput.rates_type) || 2,
  };

  const next = {
    ...plan,
    rules: [...(plan.rules || []), newRule],
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return normalizePolicy(newRule, plan.plan_id);
}

export async function updateTariffPlanRule(planIdInput: unknown, ruleIdInput: unknown, ruleInput: any) {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');

  const targetRuleId = asString(ruleIdInput);
  const existing = (plan.rules || []).find((r) => r.rule_id === targetRuleId);
  if (!existing) throw new Error('RULE_NOT_FOUND');

  const ratingGroupId = Number(ruleInput.rating_group_id ?? ruleInput.rating_group ?? existing.rating_group);
  const serviceIdentifier = Number(ruleInput.service_identifier ?? existing.service_identifier);
  const apn = asString(ruleInput.apn, existing.apn);
  const ruleId = asString(ruleInput.rule_id, targetRuleId);
  const chargingType = asString(ruleInput.charging_type, existing.charging_type);
  const unit = asString(ruleInput.unit, existing.unit || unitForChargingType(chargingType));

  const updatedRule: OcsTariffRule = {
    rule_id: ruleId,
    apn,
    rating_group: toLong(ratingGroupId, 0),
    service_identifier: toLong(serviceIdentifier, 0),
    charging_type: chargingType,
    unit,
    quota_per_grant: ruleInput.quota_per_grant !== undefined
      ? toLong(ruleInput.quota_per_grant, defaultGrantForChargingType(chargingType))
      : (existing.quota_per_grant ?? toLong(defaultGrantForChargingType(chargingType))),
    validity_time: ruleInput.validity_time !== undefined
      ? Number(ruleInput.validity_time) || 0
      : (existing.validity_time ?? defaultValidityForChargingType(chargingType)),
    volume_threshold: ruleInput.volume_threshold !== undefined
      ? toLong(ruleInput.volume_threshold, defaultThresholdForChargingType(chargingType))
      : (existing.volume_threshold ?? toLong(defaultThresholdForChargingType(chargingType))),
    priority: ruleInput.priority !== undefined ? Number(ruleInput.priority) || 100 : (existing.priority ?? 100),
    status: asString(ruleInput.status, existing.status || 'active'),
    currency: asString(ruleInput.currency, existing.currency || 'USD'),
    rates: asString(ruleInput.rates, existing.rates || '0'),
    rates_type: Number(ruleInput.rates_type) || existing.rates_type || 2,
  };

  const nextRules = (plan.rules || []).map((r) => (r.rule_id === targetRuleId ? updatedRule : r));
  const next = {
    ...plan,
    rules: nextRules,
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return normalizePolicy(updatedRule, plan.plan_id);
}

export async function deleteTariffPlanRule(planIdInput: unknown, ruleIdInput: unknown) {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');

  const targetRuleId = asString(ruleIdInput);
  const before = plan.rules || [];
  const nextRules = before.filter((r) => r.rule_id !== targetRuleId);

  const next = {
    ...plan,
    rules: nextRules,
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return { deleted: before.length !== nextRules.length };
}

export async function toggleTariffPlanRuleStatus(planIdInput: unknown, ruleIdInput: unknown) {
  const collection = await tariffPlansCollection();
  const plan = await getTariffPlanDocument(planIdInput);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');

  const targetRuleId = asString(ruleIdInput);
  const existing = (plan.rules || []).find((r) => r.rule_id === targetRuleId);
  if (!existing) throw new Error('RULE_NOT_FOUND');

  const nextStatus = (existing.status || 'active') === 'active' ? 'disabled' : 'active';
  const nextRules = (plan.rules || []).map((r) =>
    r.rule_id === targetRuleId ? { ...r, status: nextStatus } : r
  );

  const next = {
    ...plan,
    rules: nextRules,
    updated_at: new Date(),
  };

  await collection.replaceOne({ plan_id: plan.plan_id }, next);
  return { rule_id: targetRuleId, status: nextStatus };
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

  const plan = await getTariffPlanDocument(planId);
  if (!plan) throw new Error('OCS_PLAN_NOT_FOUND');
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
  if (plan.status === 'disabled') {
    throw new Error('OCS_PLAN_DISABLED');
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
      tariffPlans: new Map<string, ReturnType<typeof tariffPlanSnapshot>>(),
    };
  }

  const [subscriberCollection, balanceCollection, planCollection] = await Promise.all([
    ocsSubscribersCollection(),
    ocsBalancesCollection(),
    tariffPlansCollection(),
  ]);
  const [subscribers, balances] = await Promise.all([
    subscriberCollection.find({ imsi: { $in: imsis } }).toArray(),
    balanceCollection.find({ imsi: { $in: imsis } }).toArray(),
  ]);
  const planIds = Array.from(new Set(subscribers.map((subscriber) => subscriber.plan_id || DEFAULT_OCS_PLAN_ID)));
  if (planIds.includes(DEFAULT_OCS_PLAN_ID)) await getOrCreateDefaultPlan();
  const plans = planIds.length > 0
    ? await planCollection.find({ plan_id: { $in: planIds } }).toArray()
    : [];

  return {
    subscribers: new Map(subscribers.map((subscriber) => [subscriber.imsi, subscriber])),
    balances: new Map(balances.map((balance) => [balance.imsi, balance])),
    tariffPlans: new Map(plans.map((plan) => [plan.plan_id, tariffPlanSnapshot(plan)])),
  };
}
