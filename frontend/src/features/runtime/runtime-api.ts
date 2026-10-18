/*
 * Runtime discovery API client.
 *
 * Reads use the shared GET client; the two governed mutations use the shared
 * mutation client so the established error, retry and session semantics apply.
 * No client-supplied identity is ever sent: the server derives the host,
 * component set, resource identity and binding.
 */
import { getJson } from '../../lib/api/read-client';
import { postJson } from '../../lib/api/mutation-client';
import type {
  BootstrapApplyResult,
  BootstrapPlan,
  RuntimeMeta,
  RuntimeObservations,
} from './runtime-types';

export function fetchRuntimeMeta(): Promise<RuntimeMeta> {
  return getJson<RuntimeMeta>('/api/runtime/meta');
}

export function fetchRuntimeObservations(template?: string): Promise<RuntimeObservations> {
  const query = template ? `?template=${encodeURIComponent(template)}` : '';
  return getJson<RuntimeObservations>(`/api/runtime/observations${query}`);
}

/** One authorized, rate-limited, read-only rescan. */
export function requestRuntimeScan(): Promise<RuntimeObservations> {
  return postJson<RuntimeObservations>('/api/runtime/scan');
}

export function previewBootstrap(template: string, componentIds?: string[]): Promise<BootstrapPlan> {
  return postJson<BootstrapPlan>('/api/runtime/bootstrap/preview', {
    template,
    ...(componentIds && componentIds.length > 0 ? { componentIds } : {}),
  });
}

export function applyBootstrap(planId: string, template: string, componentIds?: string[]): Promise<BootstrapApplyResult> {
  return postJson<BootstrapApplyResult>('/api/runtime/bootstrap/apply', {
    planId,
    template,
    approve: true,
    ...(componentIds && componentIds.length > 0 ? { componentIds } : {}),
  });
}
