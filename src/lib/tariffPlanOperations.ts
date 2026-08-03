export const DEFAULT_OCS_PLAN_ID = 'plan_default_10gb';

const TARIFF_PLAN_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const RULE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const APN_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export type ChargingType = 'data_volume' | 'free' | 'voice_time' | 'sms_event';

export type NormalizedTariffRule = {
  rule_id: string;
  apn: string;
  rating_group: number;
  rating_group_id?: number;
  service_identifier: number;
  charging_type: ChargingType;
  unit: string;
  quota_per_grant: number;
  validity_time: number;
  volume_threshold: number;
  priority: number;
  status: 'active' | 'disabled';
  currency?: string;
  rates?: string;
  rates_type?: number;
};

type TariffPlanLike = {
  status?: string;
  subscriberCount: number;
  updated_at?: Date | string;
};

function asString(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function toNumber(value: unknown, fallback = 0): number {
  if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidTariffPlanId(value: unknown): value is string {
  return typeof value === 'string' && TARIFF_PLAN_ID_PATTERN.test(value.trim());
}

export function isDefaultTariffPlan(planId: unknown): boolean {
  return typeof planId === 'string' && planId.trim() === DEFAULT_OCS_PLAN_ID;
}

export function shouldBlockTariffPlanDisable(currentStatus: unknown, nextStatus: unknown, subscriberCount: unknown): boolean {
  return (
    asString(currentStatus, 'active') !== 'disabled' &&
    asString(nextStatus, 'active') === 'disabled' &&
    toNumber(subscriberCount, 0) > 0
  );
}

export function buildTariffPlanAuditFilter(planId: string) {
  const escapedPlanId = escapeRegex(planId);
  const targetRegex = { $regex: `tariff-plan:.*${escapedPlanId}`, $options: 'i' };
  return {
    $or: [
      { targetId: targetRegex },
      { 'oldData.plan_id': planId },
      { 'newData.plan_id': planId },
      { 'oldData.sourcePlanId': planId },
      { 'newData.sourcePlanId': planId },
      { 'oldData.targetPlanId': planId },
      { 'newData.targetPlanId': planId },
    ],
  };
}

export function buildTariffPlanOperationsSummary<T extends TariffPlanLike>(
  plans: T[],
  selectedPlan: T,
  history: Array<{ timestamp?: string }> = []
) {
  const activePlans = plans.filter((item) => (item.status || 'active') === 'active').length;
  const disabledPlans = plans.filter((item) => item.status === 'disabled').length;
  const totalLinkedSubscribers = plans.reduce((sum, item) => sum + (item.subscriberCount || 0), 0);
  const selectedSharePct = totalLinkedSubscribers > 0
    ? Math.round((selectedPlan.subscriberCount / totalLinkedSubscribers) * 1000) / 10
    : 0;

  return {
    totalPlans: plans.length,
    activePlans,
    disabledPlans,
    totalLinkedSubscribers,
    selectedLinkedSubscribers: selectedPlan.subscriberCount,
    selectedSharePct,
    recentActivityCount: history.length,
    lastChangedAt: selectedPlan.updated_at ? String(selectedPlan.updated_at) : history[0]?.timestamp || null,
  };
}

/**
 * Validate and normalize a tariff rule
 */
export function validateTariffRule(raw: any): {
  valid: boolean;
  isValid: boolean;
  error?: string;
  errors: string[];
  value?: NormalizedTariffRule;
} {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, isValid: false, error: 'Rule object is required', errors: ['Rule object is required'] };
  }

  const rule_id = asString(raw.rule_id).trim();
  if (!rule_id || !RULE_ID_PATTERN.test(rule_id)) {
    errors.push('Rule ID is required and must contain 1-64 alphanumeric, dash, underscore or dot characters');
  }

  const apn = asString(raw.apn || 'internet').trim().toLowerCase();
  if (!apn || !APN_PATTERN.test(apn)) {
    errors.push('APN is required and must be valid alphanumeric identifier');
  }

  const rgVal = raw.rating_group_id !== undefined ? raw.rating_group_id : raw.rating_group;
  const rating_group = Math.max(0, parseInt(String(rgVal ?? 0), 10) || 0);
  if (rgVal === undefined || rgVal === null || Number(rgVal) < 0) {
    errors.push('Rating Group ID must be a non-negative integer');
  }

  const siVal = raw.service_identifier;
  const service_identifier = Math.max(0, parseInt(String(siVal ?? 0), 10) || 0);
  if (siVal !== undefined && (isNaN(Number(siVal)) || Number(siVal) < 0)) {
    errors.push('Service Identifier must be a non-negative integer');
  }

  const charging_type: ChargingType = ['data_volume', 'free', 'voice_time', 'sms_event'].includes(raw.charging_type)
    ? raw.charging_type
    : 'data_volume';

  let unit = asString(raw.unit).trim().toLowerCase();
  if (!unit) {
    if (charging_type === 'voice_time') unit = 'seconds';
    else if (charging_type === 'sms_event') unit = 'events';
    else unit = 'bytes';
  }

  const rates = raw.rates !== undefined ? asString(raw.rates).trim() : '0';
  if (rates && isNaN(Number(rates))) {
    errors.push('Rates must be a valid number');
  } else if (Number(rates) < 0) {
    errors.push('Rates cannot be negative');
  }

  if (errors.length > 0) {
    return { valid: false, isValid: false, error: errors[0], errors };
  }

  const quota_per_grant = Math.max(0, toNumber(raw.quota_per_grant, charging_type === 'free' ? 0 : 10485760));
  const validity_time = Math.max(0, parseInt(String(raw.validity_time ?? (charging_type === 'free' ? 0 : 300)), 10) || 0);
  const volume_threshold = Math.max(0, toNumber(raw.volume_threshold, charging_type === 'free' ? 0 : 8388608));
  const priority = Math.max(0, parseInt(String(raw.priority ?? 0), 10) || 0);
  const status = raw.status === 'disabled' ? 'disabled' : 'active';

  const normalized: NormalizedTariffRule = {
    rule_id,
    apn,
    rating_group,
    rating_group_id: rating_group,
    service_identifier,
    charging_type,
    unit,
    quota_per_grant,
    validity_time,
    volume_threshold,
    priority,
    status,
    currency: raw.currency ? asString(raw.currency).trim().toUpperCase() : 'USD',
    rates,
    rates_type: Number.isFinite(Number(raw.rates_type)) ? Number(raw.rates_type) : 2,
  };

  return { valid: true, isValid: true, errors: [], value: normalized };
}

/**
 * Returns rule specificity matching level according to Open5GS OCS rule matching priority
 */
export function getRuleSpecificityLevel(rule: { apn: string; rating_group?: number; rating_group_id?: number; service_identifier?: number }): 'exact' | 'rating_group' | 'apn_wildcard' {
  const rg = Number(rule.rating_group_id ?? rule.rating_group ?? 0);
  const si = Number(rule.service_identifier || 0);
  if (rg > 0 && si > 0) return 'exact';
  if (rg > 0) return 'rating_group';
  return 'apn_wildcard';
}

export type RuleConflict = {
  ruleId1: string;
  ruleId2: string;
  rule_ids: string[];
  signature: { apn: string; rating_group_id: number; service_identifier: number };
  reason: string;
  severity: 'error' | 'warning';
};

/**
 * Detect rule conflicts within a plan
 */
export function detectRuleConflicts(rules: Array<NormalizedTariffRule | any>): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rules.length; i++) {
    const r1 = rules[i];
    const r1Id = r1.rule_id || `rule_${r1.rating_group_id ?? r1.rating_group}`;
    const r1Apn = (r1.apn || 'internet').toLowerCase();
    const r1Rg = Number(r1.rating_group_id ?? r1.rating_group ?? 0);
    const r1Si = Number(r1.service_identifier ?? 1);
    const r1Status = r1.status || 'active';

    if (seenIds.has(r1Id)) {
      conflicts.push({
        ruleId1: r1Id,
        ruleId2: r1Id,
        rule_ids: [r1Id],
        signature: { apn: r1Apn, rating_group_id: r1Rg, service_identifier: r1Si },
        reason: `Duplicate rule ID '${r1Id}' in plan`,
        severity: 'error',
      });
    }
    seenIds.add(r1Id);

    for (let j = i + 1; j < rules.length; j++) {
      const r2 = rules[j];
      const r2Id = r2.rule_id || `rule_${r2.rating_group_id ?? r2.rating_group}`;
      const r2Apn = (r2.apn || 'internet').toLowerCase();
      const r2Rg = Number(r2.rating_group_id ?? r2.rating_group ?? 0);
      const r2Si = Number(r2.service_identifier ?? 1);
      const r2Status = r2.status || 'active';

      if (r1Apn === r2Apn) {
        // Check exact match overlap
        if (r1Rg === r2Rg && r1Si === r2Si) {
          if (r1Status === 'active' && r2Status === 'active') {
            conflicts.push({
              ruleId1: r1Id,
              ruleId2: r2Id,
              rule_ids: [r1Id, r2Id],
              signature: { apn: r1Apn, rating_group_id: r1Rg, service_identifier: r1Si },
              reason: `Ambiguous match: Both rules have identical APN '${r1Apn}', RG '${r1Rg}', SI '${r1Si}'`,
              severity: 'error',
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * Check core APN coverage in plan
 */
export function checkCoreApnCoverage(rules: Array<{ apn: string; status?: string }>): {
  hasInternet: boolean;
  hasIms: boolean;
  suggestions: string[];
} {
  const activeApns = new Set(
    rules
      .filter((r) => (r.status || 'active') === 'active')
      .map((r) => r.apn.toLowerCase().trim())
  );

  const hasInternet = activeApns.has('internet');
  const hasIms = activeApns.has('ims');
  const suggestions: string[] = [];

  if (!hasInternet) {
    suggestions.push("Missing active rule for 'internet' APN (primary data bearer)");
  }
  if (!hasIms) {
    suggestions.push("Missing active rule for 'ims' APN (VoLTE/VoNR SIP signaling bearer)");
  }

  return { hasInternet, hasIms, suggestions };
}

/**
 * Clean and normalize a plan for JSON export
 */
export function normalizeTariffPlanExport(plan: any) {
  return {
    version: '1.0',
    exported_at: new Date().toISOString(),
    plan_id: plan.plan_id,
    name: plan.name || plan.plan_id,
    description: plan.description || '',
    status: plan.status || 'active',
    quota_per_grant: toNumber(plan.quota_per_grant, 10485760),
    validity_time: toNumber(plan.validity_time, 300),
    volume_threshold: toNumber(plan.volume_threshold, 8388608),
    rules: (plan.rules || []).map((rule: any) => {
      const { value } = validateTariffRule(rule);
      return value || rule;
    }),
  };
}

export const exportTariffPlanJson = normalizeTariffPlanExport;

/**
 * Validate imported JSON schema for creating a tariff plan
 */
export function normalizeImportedPlan(data: any): {
  isValid: boolean;
  valid: boolean;
  error?: string;
  errors: string[];
  warnings: string[];
  plan: any;
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!data || typeof data !== 'object') {
    return {
      isValid: false,
      valid: false,
      error: 'Invalid JSON content: expected an object',
      errors: ['Invalid JSON content: expected an object'],
      warnings: [],
      plan: null,
    };
  }

  const plan_id = asString(data.plan_id).trim();
  if (!isValidTariffPlanId(plan_id)) {
    errors.push('Invalid plan_id in imported JSON: 1-64 alphanumeric, dash, dot or underscore');
  }

  const name = asString(data.name || plan_id).trim();
  const description = asString(data.description || '').trim();
  const status = data.status === 'disabled' ? 'disabled' : 'active';
  const quota_per_grant = Math.max(0, toNumber(data.quota_per_grant, 10485760));
  const validity_time = Math.max(0, toNumber(data.validity_time, 300));
  const volume_threshold = Math.max(0, toNumber(data.volume_threshold, 8388608));

  const rawRules = Array.isArray(data.rules) ? data.rules : [];
  const normalizedRules: NormalizedTariffRule[] = [];

  for (let i = 0; i < rawRules.length; i++) {
    const validation = validateTariffRule(rawRules[i]);
    if (!validation.valid || !validation.value) {
      errors.push(`Invalid rule at index ${i}: ${validation.error}`);
    } else {
      normalizedRules.push(validation.value);
    }
  }

  if (normalizedRules.length > 0) {
    const conflicts = detectRuleConflicts(normalizedRules);
    conflicts.forEach((c) => {
      if (c.severity === 'error') {
        warnings.push(`Rule conflict: ${c.reason}`);
      }
    });
  }

  const isValid = errors.length === 0;

  return {
    isValid,
    valid: isValid,
    error: errors[0],
    errors,
    warnings,
    plan: {
      plan_id,
      name,
      description,
      status,
      quota_per_grant,
      validity_time,
      volume_threshold,
      rules: normalizedRules,
    },
  };
}

export const validateTariffPlanImport = normalizeImportedPlan;
