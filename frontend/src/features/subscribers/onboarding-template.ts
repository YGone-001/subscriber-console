/*
 * The default onboarding template is applied only when creating a subscriber.
 * Existing subscribers start empty and are populated exclusively from the read
 * API, so absent OCS records stay "not configured" instead of inheriting a
 * plausible-looking quota.
 */
export const ONBOARDING_TEMPLATE = {
  dataTotal: "10 GB",
  dataBalance: "10 GB",
  voiceTotal: "1h",
  voiceBalance: "1h",
  smsTotal: "100",
  smsBalance: "100",
  recommendedValiditySeconds: 2592000,
  recommendedVolumeThreshold: 1073741824,
} as const;

export type OnboardingPlanLike = {
  plan_id: string;
  status?: string;
  validity_time?: number;
  volume_threshold?: number;
};

export function isRecommendedOnboardingPlan(plan: OnboardingPlanLike): boolean {
  return (plan.status || "active") === "active"
    && Number(plan.validity_time || 0) === ONBOARDING_TEMPLATE.recommendedValiditySeconds
    && Number(plan.volume_threshold || 0) === ONBOARDING_TEMPLATE.recommendedVolumeThreshold;
}
