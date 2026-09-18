import {
  createRatingPolicy,
  deleteRatingPolicy,
  getRatingPolicy,
  listRatingPolicies,
  updateRatingPolicy,
} from '@/server/repositories/ocsBillingRepository';

export type RatingReferenceScan = {
  count: number;
  examples: string[];
};

export async function listRatings(planId?: unknown) {
  return listRatingPolicies(planId);
}

export async function getRating(id: string | number, planId?: unknown) {
  return getRatingPolicy(id, planId);
}

export async function createRating(input: {
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
}, planId?: unknown) {
  return createRatingPolicy(input, planId);
}

export async function updateRating(id: string, input: {
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
}, planId?: unknown) {
  return updateRatingPolicy(id, input, planId);
}

export async function scanRatingReferences(_id: string): Promise<RatingReferenceScan> {
  void _id;
  return { count: 0, examples: [] };
}

export async function deleteRating(id: string, planId?: unknown) {
  return deleteRatingPolicy(id, planId);
}
