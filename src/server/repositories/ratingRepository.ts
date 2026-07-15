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

export async function listRatings() {
  return listRatingPolicies();
}

export async function getRating(id: string | number) {
  return getRatingPolicy(id);
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
}) {
  return createRatingPolicy(input);
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
}) {
  return updateRatingPolicy(id, input);
}

export async function scanRatingReferences(_id: string): Promise<RatingReferenceScan> {
  void _id;
  return { count: 0, examples: [] };
}

export async function deleteRating(id: string) {
  return deleteRatingPolicy(id);
}
