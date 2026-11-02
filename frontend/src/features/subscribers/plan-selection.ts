export type PlanSelectionCandidate = {
  plan_id: string;
  status?: string;
  isDefault?: boolean;
  quota_per_grant?: number;
  volume_threshold?: number;
};

// The API marks the canonical default plan. Fall back to the first active plan
// so a missing marker or a disabled default never leaves the form without a
// choice.
export function selectDefaultPlanId(plans: PlanSelectionCandidate[]): string {
  const active = (plan: PlanSelectionCandidate) => (plan.status || "active") === "active";
  return plans.find((plan) => plan.isDefault && active(plan))?.plan_id
    || plans.find(active)?.plan_id
    || plans[0]?.plan_id
    || "";
}

// Low balance is derived from the remaining quota, so a threshold above the
// granted quota marks the first grant as low. The tariff form refuses that
// combination; this guard keeps the create form from pre-filling a plan the
// catalog already treats as inconsistent.
export function planThresholdExceedsQuota(plan: PlanSelectionCandidate | undefined): boolean {
  const quota = Number(plan?.quota_per_grant ?? 0);
  const threshold = Number(plan?.volume_threshold ?? 0);
  return quota > 0 && threshold > quota;
}
