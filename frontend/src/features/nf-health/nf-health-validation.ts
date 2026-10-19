import type { CollectionMode, NfHealthMeta, ServiceKind } from './nf-health-types';
import type { NfHealthTargetForm, TargetProbeForm } from './nf-health-builders';

export type ValidationMessageKey = string;

export function validateTargetName(name: string): ValidationMessageKey | null {
  const trimmed = name.trim();
  if (!trimmed) return 'nf_health_validation_name_required';
  if (trimmed.length > 128) return 'nf_health_validation_name_too_long';
  return null;
}

export function validateResourceId(resourceId: string): ValidationMessageKey | null {
  // The Inventory resource is the authoritative identity: every new target
  // references an existing Inventory resource server-side.
  if (!resourceId.trim()) return 'nf_health_validation_resource_required';
  return null;
}

export function validateCandidateId(candidateId: string): ValidationMessageKey | null {
  // The Discovery candidate association is optional. EPC, IMS and
  // Inventory-only 5GC targets must be creatable without any NRF candidate.
  if (!candidateId.trim()) return null;
  return null;
}

export function validateCollectorProfile(profile: string, meta: NfHealthMeta | null): ValidationMessageKey | null {
  if (!profile) return 'nf_health_validation_profile_required';
  if (meta && !meta.collectorProfiles.includes(profile)) {
    return 'nf_health_validation_profile_unsupported';
  }
  return null;
}

export function validateDestination(
  destination: string,
  meta: NfHealthMeta | null,
  processOnly = false,
): ValidationMessageKey | null {
  // process_only never performs an HTTP probe: no metrics endpoint is required
  // and none is accepted.
  if (processOnly) return null;
  const trimmed = destination.trim();
  if (!trimmed) return 'nf_health_validation_destination_required';
  if (meta && meta.allowedDestinations.length > 0 && !meta.allowedDestinations.includes(trimmed)) {
    return 'nf_health_validation_destination_unauthorized';
  }
  return null;
}

export function validateServiceUnit(
  serviceUnit: string,
  serviceKind: ServiceKind,
  meta: NfHealthMeta | null,
  processOnly = false,
): ValidationMessageKey | null {
  const trimmed = serviceUnit.trim();
  if (serviceKind === 'none') {
    return processOnly ? 'nf_health_validation_process_only_inspection_required' : null;
  }
  if (!trimmed) return 'nf_health_validation_service_unit_required';
  if (meta && meta.allowedServiceUnits.length > 0 && !meta.allowedServiceUnits.includes(trimmed)) {
    return 'nf_health_validation_service_unit_unauthorized';
  }
  return null;
}

export function validateCollectionMode(mode: string, meta: NfHealthMeta | null): ValidationMessageKey | null {
  if (meta && !meta.collectionModes.includes(mode as CollectionMode)) {
    return 'nf_health_validation_mode_unsupported';
  }
  return null;
}

export function validateInterval(intervalSeconds: number, meta: NfHealthMeta | null): ValidationMessageKey | null {
  if (!Number.isFinite(intervalSeconds) || !Number.isInteger(intervalSeconds)) {
    return 'nf_health_validation_interval_integer';
  }
  const min = meta?.minIntervalSeconds ?? 60;
  const max = meta?.maxIntervalSeconds ?? 3600;
  if (intervalSeconds < min || intervalSeconds > max) {
    return 'nf_health_validation_interval_range';
  }
  return null;
}

/* Probe rows are validated before submission: a bounded list, one declaration
 * per family and an allowlisted destination. process_only has no HTTP probe. */
export function validateProbes(
  probes: TargetProbeForm[],
  meta: NfHealthMeta | null,
  processOnly = false,
): ValidationMessageKey | null {
  if (processOnly) {
    return probes.length > 0 ? 'nf_health_validation_probes_process_only' : null;
  }
  const max = meta?.maxInterfaceProbes ?? 4;
  if (probes.length > max) return 'nf_health_validation_probes_too_many';
  const families = new Set<string>();
  for (const probe of probes) {
    if (!probe.destination.trim()) return 'nf_health_validation_probe_destination_required';
    if (families.has(probe.family)) return 'nf_health_validation_probe_duplicate';
    families.add(probe.family);
  }
  return null;
}

export function validateTargetForm(
  form: NfHealthTargetForm,
  meta: NfHealthMeta | null,
): ValidationMessageKey | null {
  const processOnly = form.collectorProfile === 'process_only';
  return (
    validateResourceId(form.resourceId) ??
    validateTargetName(form.name) ??
    validateCollectorProfile(form.collectorProfile, meta) ??
    validateDestination(form.metricsDestination, meta, processOnly) ??
    validateProbes(form.probes, meta, processOnly) ??
    validateServiceUnit(form.serviceUnit, form.serviceKind, meta, processOnly) ??
    validateCollectionMode(form.collectionMode, meta) ??
    validateInterval(form.intervalSeconds, meta) ??
    validateCandidateId(form.candidateId)
  );
}

export function isServiceKind(value: string): value is ServiceKind {
  return value === 'systemd' || value === 'process' || value === 'none';
}

export function isCollectionMode(value: string): value is CollectionMode {
  return value === 'manual' || value === 'scheduled';
}
