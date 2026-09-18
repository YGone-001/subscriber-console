/**
 * Cross-runtime fixtures for Profile CRUD.
 * Node and Go must produce identical results for:
 * - POST (create)
 * - PUT existing (update preserves untouched fields)
 * - PUT missing (sparse insert)
 */

import { createHash } from 'node:crypto';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

// ─── Fixture 1: POST create ───

export const POST_BODY = {
  title: 'Test Profile',
  description: 'A test profile',
};

export const POST_EXPECTED_FIELDS = {
  name: 'fixture_post_profile',
  title: 'Test Profile',
  description: 'A test profile',
};

export function validatePostResponse(response: Record<string, unknown>, user: string): string[] {
  const errors: string[] = [];
  if (response.name !== 'fixture_post_profile') errors.push(`name: expected fixture_post_profile, got ${response.name}`);
  if (response.title !== 'Test Profile') errors.push(`title: expected Test Profile, got ${response.title}`);
  if (response.description !== 'A test profile') errors.push(`description: expected A test profile, got ${response.description}`);
  if (!response.createdAt) errors.push('createdAt missing');
  if (response.createdBy !== user) errors.push(`createdBy: expected ${user}, got ${response.createdBy}`);
  if (!response.updatedAt) errors.push('updatedAt missing');
  if (response.updatedBy !== user) errors.push(`updatedBy: expected ${user}, got ${response.updatedBy}`);
  return errors;
}

// ─── Fixture 2: PUT existing (preserves untouched fields) ───

export const PUT_EXISTING_INITIAL = {
  name: 'fixture_put_existing',
  title: 'Original Title',
  description: 'Original description',
  auth: {
    k: '00000000000000000000000000000000',
    opc: '00000000000000000000000000000000',
    amf: '8000',
  },
  ambr: {
    downlink: { unit: 2, value: 10 },
    uplink: { unit: 2, value: 10 },
  },
  sliceList: [
    {
      default_indicator: true,
      sd: '000001',
      sst: 1,
      session_list: [],
    },
  ],
  ocsDefaults: {
    planId: 'custom_plan',
  },
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'original_user',
  updatedAt: '2024-01-01T00:00:00.000Z',
  updatedBy: 'original_user',
};

export const PUT_EXISTING_BODY = {
  title: 'Changed Title',
};

export function validatePutExistingResponse(
  response: Record<string, unknown>,
  user: string
): string[] {
  const errors: string[] = [];

  // Title should be changed
  if (response.title !== 'Changed Title')
    errors.push(`title: expected Changed Title, got ${response.title}`);

  // Untouched fields should be preserved
  if (response.description !== 'Original description')
    errors.push(`description should be preserved, got ${response.description}`);

  const auth = response.auth as Record<string, unknown>;
  if (!auth || auth.k !== '00000000000000000000000000000000')
    errors.push('auth.k should be preserved');
  if (!auth || auth.opc !== '00000000000000000000000000000000')
    errors.push('auth.opc should be preserved');
  if (!auth || auth.amf !== '8000') errors.push('auth.amf should be preserved');

  const ambr = response.ambr as Record<string, unknown>;
  const downlink = ambr?.downlink as Record<string, unknown>;
  if (!downlink || downlink.unit !== 2 || downlink.value !== 10)
    errors.push('ambr.downlink should be preserved');

  const sliceList = response.sliceList as unknown[];
  if (!sliceList || sliceList.length !== 1) errors.push('sliceList should be preserved');

  const ocsDefaults = response.ocsDefaults as Record<string, unknown>;
  if (!ocsDefaults || ocsDefaults.planId !== 'custom_plan')
    errors.push('ocsDefaults should be preserved');

  // Immutable fields
  if (response.createdAt !== '2024-01-01T00:00:00.000Z')
    errors.push('createdAt should be preserved');
  if (response.createdBy !== 'original_user') errors.push('createdBy should be preserved');

  // System fields should be updated
  if (response.updatedBy !== user) errors.push(`updatedBy: expected ${user}, got ${response.updatedBy}`);

  return errors;
}

// ─── Fixture 3: PUT missing (sparse insert) ───

export const PUT_MISSING_BODY = {
  title: 'New Profile Title',
};

export function validatePutMissingResponse(
  response: Record<string, unknown>,
  user: string
): string[] {
  const errors: string[] = [];

  if (response.name !== 'fixture_put_missing')
    errors.push(`name: expected fixture_put_missing, got ${response.name}`);
  if (response.title !== 'New Profile Title')
    errors.push(`title: expected New Profile Title, got ${response.title}`);
  if (!response.createdAt) errors.push('createdAt missing');
  if (response.createdBy !== user) errors.push(`createdBy: expected ${user}, got ${response.createdBy}`);
  if (!response.updatedAt) errors.push('updatedAt missing');
  if (response.updatedBy !== user) errors.push(`updatedBy: expected ${user}, got ${response.updatedBy}`);

  // Should NOT have default auth/ambr/sliceList/ocsDefaults
  if (response.auth !== undefined) errors.push('auth should not be present for sparse insert');
  if (response.ambr !== undefined) errors.push('ambr should not be present for sparse insert');
  if (response.sliceList !== undefined) errors.push('sliceList should not be present for sparse insert');
  if (response.ocsDefaults !== undefined) errors.push('ocsDefaults should not be present for sparse insert');

  return errors;
}

// ─── Fixture 4: PUT with unknown field (should fail) ───

export const PUT_UNKNOWN_FIELD_BODY = {
  title: 'Valid Title',
  unknown_xyz: 'should_be_rejected',
};

export function validateUnknownFieldError(response: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (response.code !== 'INVALID_PROFILE_UPDATE')
    errors.push(`code: expected INVALID_PROFILE_UPDATE, got ${response.code}`);
  return errors;
}

// ─── Export all fixtures ───

export const fixtures = {
  post: {
    body: POST_BODY,
    expected: POST_EXPECTED_FIELDS,
    validate: validatePostResponse,
  },
  putExisting: {
    initial: PUT_EXISTING_INITIAL,
    body: PUT_EXISTING_BODY,
    validate: validatePutExistingResponse,
  },
  putMissing: {
    body: PUT_MISSING_BODY,
    validate: validatePutMissingResponse,
  },
  putUnknownField: {
    body: PUT_UNKNOWN_FIELD_BODY,
    validate: validateUnknownFieldError,
  },
};
