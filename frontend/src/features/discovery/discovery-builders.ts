/**
 * Request builders for Discovery mutations.
 *
 * Builders are the only place that shape link/unlink payloads so the UI never
 * invents server-owned fields and never treats observation state as health.
 */

import type {
  LinkCandidateRequest,
  NfObservation,
  UnlinkCandidateRequest,
} from './discovery-types';
import { validateResourceId } from './discovery-validation';

export function buildLinkCandidateRequest(
  candidate: Pick<NfObservation, 'revision'>,
  resourceId: string,
): LinkCandidateRequest {
  if (!Number.isInteger(candidate.revision) || candidate.revision <= 0) {
    throw new Error('discovery_validation_revision');
  }
  const resourceError = validateResourceId(resourceId);
  if (resourceError) throw new Error(resourceError);
  return {
    expectedRevision: candidate.revision,
    resourceId: resourceId.trim(),
  };
}

export function buildUnlinkCandidateRequest(
  candidate: Pick<NfObservation, 'revision'>,
): UnlinkCandidateRequest {
  if (!Number.isInteger(candidate.revision) || candidate.revision <= 0) {
    throw new Error('discovery_validation_revision');
  }
  return { expectedRevision: candidate.revision };
}

/** Human-readable observed endpoint line used by detail surfaces. */
export function formatObservedEndpoint(endpoint: {
  serviceName?: string;
  scheme?: string;
  addressType?: string;
  address?: string;
  port?: number;
}): string {
  const scheme = endpoint.scheme ? `${endpoint.scheme}://` : '';
  const address = endpoint.address ?? '';
  const port = endpoint.port ? `:${endpoint.port}` : '';
  const target = `${scheme}${address}${port}` || '-';
  return endpoint.serviceName ? `${endpoint.serviceName} -> ${target}` : target;
}
