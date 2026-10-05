import type {
  CreateResourceRequest,
  MutableResource,
  RetireResourceRequest,
  UpdateResourceRequest,
} from './inventory-types';
import {
  FORBIDDEN_SERVER_FIELDS,
  validateAttributes,
  validateMachineName,
  validateManagementEndpoints,
} from './inventory-validation';

export function buildCreateResourceRequest(input: Partial<CreateResourceRequest>): CreateResourceRequest {
  if (!input.kind || !input.kind.trim()) {
    throw new Error('Resource kind is required.');
  }
  const nameError = validateMachineName(input.name ?? '');
  if (nameError) {
    throw new Error(nameError);
  }
  if (!input.domain || !input.domain.trim()) {
    throw new Error('Telecom domain is required.');
  }

  for (const field of FORBIDDEN_SERVER_FIELDS) {
    if (field in input && (input as Record<string, unknown>)[field] !== undefined) {
      throw new Error(`Field "${field}" is server-owned and cannot be provided in create request.`);
    }
  }

  if (input.attributes) {
    const attrError = validateAttributes(input.attributes);
    if (attrError) {
      throw new Error(attrError);
    }
  }

  if (input.managementEndpoints) {
    const epError = validateManagementEndpoints(input.managementEndpoints);
    if (epError) {
      throw new Error(epError);
    }
  }

  const req: CreateResourceRequest = {
    kind: input.kind.trim(),
    name: (input.name ?? '').trim(),
    domain: input.domain.trim(),
  };

  if (input.displayName && input.displayName.trim()) req.displayName = input.displayName.trim();
  if (input.description && input.description.trim()) req.description = input.description.trim();
  if (input.role && input.role.trim()) req.role = input.role.trim();
  if (input.lifecycleState && input.lifecycleState.trim()) {
    if (input.lifecycleState.trim() === 'retired') {
      throw new Error('Initial lifecycleState cannot be retired; use planned, active, or maintenance.');
    }
    req.lifecycleState = input.lifecycleState.trim();
  }
  if (input.vendor && input.vendor.trim()) req.vendor = input.vendor.trim();
  if (input.model && input.model.trim()) req.model = input.model.trim();
  if (input.software) req.software = input.software;
  if (input.managementEndpoints && input.managementEndpoints.length > 0) req.managementEndpoints = input.managementEndpoints;
  if (input.capabilities && input.capabilities.length > 0) req.capabilities = input.capabilities;
  if (input.labels && Object.keys(input.labels).length > 0) req.labels = input.labels;
  if (input.attributes && Object.keys(input.attributes).length > 0) req.attributes = input.attributes;

  return req;
}

export function buildUpdateResourceRequest(
  expectedRevision: number,
  input: Partial<MutableResource>,
): UpdateResourceRequest {
  if (typeof expectedRevision !== 'number' || expectedRevision <= 0 || !Number.isInteger(expectedRevision)) {
    throw new Error('expectedRevision must be a positive integer (>= 1).');
  }

  if (!input.kind || !input.kind.trim()) {
    throw new Error('Resource kind is required.');
  }
  const nameError = validateMachineName(input.name ?? '');
  if (nameError) {
    throw new Error(nameError);
  }
  if (!input.domain || !input.domain.trim()) {
    throw new Error('Telecom domain is required.');
  }
  if (!input.lifecycleState || !input.lifecycleState.trim()) {
    throw new Error('lifecycleState is required for update.');
  }
  if (input.lifecycleState.trim() === 'retired') {
    throw new Error('Cannot update lifecycleState to retired via PUT; use retire operation.');
  }

  for (const field of FORBIDDEN_SERVER_FIELDS) {
    if (field in input && (input as Record<string, unknown>)[field] !== undefined) {
      throw new Error(`Field "${field}" is server-owned and cannot be provided in update request.`);
    }
  }

  if (input.attributes) {
    const attrError = validateAttributes(input.attributes);
    if (attrError) {
      throw new Error(attrError);
    }
  }

  if (input.managementEndpoints) {
    const epError = validateManagementEndpoints(input.managementEndpoints);
    if (epError) {
      throw new Error(epError);
    }
  }

  const mutable: MutableResource = {
    kind: input.kind.trim(),
    name: (input.name ?? '').trim(),
    domain: input.domain.trim(),
    lifecycleState: input.lifecycleState.trim(),
  };

  if (input.displayName && input.displayName.trim()) mutable.displayName = input.displayName.trim();
  if (input.description && input.description.trim()) mutable.description = input.description.trim();
  if (input.role && input.role.trim()) mutable.role = input.role.trim();
  if (input.vendor && input.vendor.trim()) mutable.vendor = input.vendor.trim();
  if (input.model && input.model.trim()) mutable.model = input.model.trim();
  if (input.software) mutable.software = input.software;
  if (input.managementEndpoints) mutable.managementEndpoints = input.managementEndpoints;
  if (input.capabilities) mutable.capabilities = input.capabilities;
  if (input.labels) mutable.labels = input.labels;
  if (input.attributes) mutable.attributes = input.attributes;

  return {
    expectedRevision,
    resource: mutable,
  };
}

export function buildRetireResourceRequest(
  expectedRevision: number,
  reason: string,
): RetireResourceRequest {
  if (typeof expectedRevision !== 'number' || expectedRevision <= 0 || !Number.isInteger(expectedRevision)) {
    throw new Error('expectedRevision must be a positive integer (>= 1).');
  }
  if (!reason || !reason.trim()) {
    throw new Error('Retirement reason is required.');
  }

  return {
    expectedRevision,
    reason: reason.trim(),
  };
}
