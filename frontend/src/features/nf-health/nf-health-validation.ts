import type { CollectionMode, NfHealthMeta, ServiceKind } from './nf-health-types';
import type { NfHealthTargetForm } from './nf-health-builders';

export type ValidationMessageKey = string;

export function validateTargetName(name: string): ValidationMessageKey | null {
  const trimmed = name.trim();
  if (!trimmed) return 'nf_health_validation_name_required';
  if (trimmed.length > 128) return 'nf_health_validation_name_too_long';
  return null;
}

export function validateCandidateId(candidateId: string): ValidationMessageKey | null {
  if (!candidateId.trim()) return 'nf_health_validation_candidate_required';
  return null;
}

export function validateCollectorProfile(profile: string, meta: NfHealthMeta | null): ValidationMessageKey | null {
  if (!profile) return 'nf_health_validation_profile_required';
  if (meta && !meta.collectorProfiles.includes(profile)) {
    return 'nf_health_validation_profile_unsupported';
  }
  return null;
}

export function validateDestination(destination: string, meta: NfHealthMeta | null): ValidationMessageKey | null {
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
): ValidationMessageKey | null {
  const trimmed = serviceUnit.trim();
  if (serviceKind === 'none') return null;
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

export function validateTargetForm(
  form: NfHealthTargetForm,
  meta: NfHealthMeta | null,
): ValidationMessageKey | null {
  return (
    validateCandidateId(form.candidateId) ??
    validateTargetName(form.name) ??
    validateCollectorProfile(form.collectorProfile, meta) ??
    validateDestination(form.metricsDestination, meta) ??
    validateServiceUnit(form.serviceUnit, form.serviceKind, meta) ??
    validateCollectionMode(form.collectionMode, meta) ??
    validateInterval(form.intervalSeconds, meta)
  );
}

export function isServiceKind(value: string): value is ServiceKind {
  return value === 'systemd' || value === 'process' || value === 'none';
}

export function isCollectionMode(value: string): value is CollectionMode {
  return value === 'manual' || value === 'scheduled';
}
