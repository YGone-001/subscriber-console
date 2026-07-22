export const DEFAULT_OCS_PLAN_ID = 'plan_default_10gb';

const TARIFF_PLAN_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

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
    lastChangedAt: selectedPlan.updated_at || history[0]?.timestamp || null,
  };
}
