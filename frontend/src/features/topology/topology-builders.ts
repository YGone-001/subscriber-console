import type {
  CreateEdgeRequest,
  MutableEdge,
  RetireEdgeRequest,
  UpdateEdgeRequest,
} from './topology-types';
import {
  assertNoServerOwnedFields,
  validateAttributes,
  validateDescription,
  validateLabels,
} from './topology-validation';

const UUID_V4_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

function validateMetadata(
  description: string | undefined,
  labels: Record<string, string> | undefined,
  attributes: Record<string, unknown> | undefined,
): void {
  if (description) {
    const error = validateDescription(description);
    if (error) throw new Error(error);
  }
  if (labels) {
    const error = validateLabels(labels);
    if (error) throw new Error(error);
  }
  if (attributes) {
    const error = validateAttributes(attributes);
    if (error) throw new Error(error);
  }
}

export function buildCreateEdgeRequest(input: Partial<CreateEdgeRequest>): CreateEdgeRequest {
  assertNoServerOwnedFields(input as Record<string, unknown>);

  if (!input.relationshipType || !input.relationshipType.trim()) {
    throw new Error('Relationship type is required.');
  }
  if (!input.fromResourceId || !isUuidV4(input.fromResourceId)) {
    throw new Error('A valid source resource must be selected.');
  }
  if (!input.toResourceId || !isUuidV4(input.toResourceId)) {
    throw new Error('A valid target resource must be selected.');
  }
  if (input.fromResourceId === input.toResourceId) {
    throw new Error('A relationship cannot connect a resource to itself.');
  }

  const description = input.description?.trim();
  validateMetadata(description, input.labels, input.attributes);

  const req: CreateEdgeRequest = {
    relationshipType: input.relationshipType.trim(),
    fromResourceId: input.fromResourceId,
    toResourceId: input.toResourceId,
  };
  if (description) req.description = description;
  if (input.labels && Object.keys(input.labels).length > 0) req.labels = input.labels;
  if (input.attributes && Object.keys(input.attributes).length > 0) req.attributes = input.attributes;

  return req;
}

export function buildUpdateEdgeRequest(
  expectedRevision: number,
  input: Partial<MutableEdge>,
): UpdateEdgeRequest {
  if (typeof expectedRevision !== 'number' || expectedRevision <= 0 || !Number.isInteger(expectedRevision)) {
    throw new Error('expectedRevision must be a positive integer (>= 1).');
  }
  assertNoServerOwnedFields(input as Record<string, unknown>);

  const description = input.description?.trim();
  validateMetadata(description, input.labels, input.attributes);

  // An empty metadata replacement is explicitly supported: omitted keys clear
  // the stored value rather than preserving the previous one.
  const edge: MutableEdge = {
    description: description ?? '',
    labels: input.labels ?? {},
    attributes: input.attributes ?? {},
  };

  return { expectedRevision, edge };
}

export function buildRetireEdgeRequest(expectedRevision: number, reason: string): RetireEdgeRequest {
  if (typeof expectedRevision !== 'number' || expectedRevision <= 0 || !Number.isInteger(expectedRevision)) {
    throw new Error('expectedRevision must be a positive integer (>= 1).');
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error('A retirement reason is required.');
  }
  if (trimmed.length > 512) {
    throw new Error('The retirement reason cannot exceed 512 characters.');
  }
  return { expectedRevision, reason: trimmed };
}
