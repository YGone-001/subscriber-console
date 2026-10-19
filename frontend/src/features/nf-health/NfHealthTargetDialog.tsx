/*
 * NF Health monitoring target form dialog.
 *
 * Covers add and edit paths for an approved monitoring target. The Inventory
 * resource is the authoritative identity; the Discovery candidate is an
 * optional association. Destinations, collector profiles and service units are
 * constrained to the server-owned metadata allowlists; free-form shell
 * commands are never accepted.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { useI18n } from '../../providers/I18nProvider';
import { fetchDiscoveryCandidates } from '../discovery/discovery-api';
import type { NfObservation } from '../discovery/discovery-types';
import { fetchInventoryResources } from '../inventory/inventory-api';
import type { Resource } from '../inventory/inventory-types';
import { createNfHealthTarget, updateNfHealthTarget } from './nf-health-api';
import {
  buildCreateTargetRequest,
  buildUpdateTargetRequest,
  createEmptyTargetForm,
  probeFormRows,
  splitMetricsEndpoint,
  type NfHealthTargetForm,
  type TargetProbeForm,
} from './nf-health-builders';
import { isCollectionMode, isServiceKind, validateTargetForm } from './nf-health-validation';
import type {
  CollectionMode,
  HealthTarget,
  NfHealthMeta,
  ProbeFamily,
  ServiceKind,
} from './nf-health-types';
import styles from '../../styles/modules/nf-health.module.css';

type Props = {
  open: boolean;
  mode: 'create' | 'edit';
  meta: NfHealthMeta | null;
  existing?: HealthTarget | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onFormError: (message: string) => void;
};

const CANDIDATE_LIMIT = 50;
const RESOURCE_PAGE_LIMIT = 20;

function defaultProbePath(family: ProbeFamily): string {
  if (family === 'oam') return '/oam';
  if (family === 'health') return '/healthz';
  return '/sbi';
}

export function NfHealthTargetDialog({
  open,
  mode,
  meta,
  existing,
  onClose,
  onSaved,
  onFormError,
}: Props) {
  const { t } = useI18n();
  const [form, setForm] = useState<NfHealthTargetForm>(() =>
    createEmptyTargetForm(meta?.defaultIntervalSeconds ?? 120),
  );
  const [candidates, setCandidates] = useState<NfObservation[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [resources, setResources] = useState<Resource[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesHasMore, setResourcesHasMore] = useState(false);
  const [resourcesCursor, setResourcesCursor] = useState<string | null>(null);
  const [resourceQuery, setResourceQuery] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setResourceQuery('');
    if (mode === 'edit' && existing) {
      const split = splitMetricsEndpoint(existing.metricsEndpoint);
      setForm({
        resourceId: existing.resourceId ?? '',
        candidateId: existing.candidateId ?? '',
        name: existing.name,
        collectorProfile: existing.collectorProfile,
        metricsDestination: split.destination,
        metricsPath: split.path,
        probes: probeFormRows(existing.probes),
        serviceUnit: existing.serviceUnit ?? '',
        serviceKind: existing.serviceKind,
        collectionMode: existing.collectionMode,
        intervalSeconds: existing.intervalSeconds,
        enabled: existing.enabled,
      });
      return;
    }
    setForm(createEmptyTargetForm(meta?.defaultIntervalSeconds ?? 120));
  }, [open, mode, existing, meta]);

  useEffect(() => {
    if (!open || mode !== 'create') return;
    let cancelled = false;
    setCandidatesLoading(true);
    void fetchDiscoveryCandidates({ limit: CANDIDATE_LIMIT })
      .then((response) => {
        if (!cancelled) setCandidates(response.candidates ?? []);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode]);

  // The Inventory resource listing is paginated server-side: the picker never
  // assumes every resource fits in one response page. Only active resources
  // are offered; the server enforces the monitored resource kinds and the
  // derived domain / NF type.
  const MONITORED_KINDS = new Set(['network_function', 'network_function_instance']);
  const loadResources = (query: string, cursor?: string, append = false) => {
    let cancelled = false;
    setResourcesLoading(true);
    void fetchInventoryResources({
      lifecycleState: 'active',
      q: query || undefined,
      cursor,
      limit: RESOURCE_PAGE_LIMIT,
    })
      .then((response) => {
        if (cancelled) return;
        const rows = (response.resources ?? []).filter((item) => MONITORED_KINDS.has(item.kind));
        setResources((current) => (append ? [...current, ...rows] : rows));
        setResourcesHasMore(Boolean(response.page?.hasMore && response.page?.nextCursor));
        setResourcesCursor(response.page?.nextCursor ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        if (!append) setResources([]);
        setResourcesHasMore(false);
      })
      .finally(() => {
        if (!cancelled) setResourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    if (!open || mode !== 'create') return;
    const cancel = loadResources(resourceQuery);
    return cancel;
    // loadResources is stable; resourceQuery drives the first page reload.
  }, [open, mode, resourceQuery]);

  const selectedResource = useMemo(
    () =>
      resources.find((item) => item.resourceId === form.resourceId) ??
      (existing && existing.resourceId === form.resourceId ? null : null),
    [resources, form.resourceId, existing],
  );

  const selectedCandidate = useMemo(
    () => candidates.find((item) => item.candidateId === form.candidateId) ?? null,
    [candidates, form.candidateId],
  );

  const isProcessOnly = form.collectorProfile === 'process_only';

  const patch = (next: Partial<NfHealthTargetForm>) => {
    setForm((current) => ({ ...current, ...next }));
    setFormError(null);
  };

  const maxProbes = meta?.maxInterfaceProbes ?? 4;
  const availableFamilies = useMemo(
    () => (meta?.probeFamilies ?? ['metrics', 'sbi', 'oam', 'health']).filter((family) => family !== 'metrics'),
    [meta],
  );

  const addProbe = () => {
    setFormError(null);
    setForm((current) => {
      if (current.probes.length >= maxProbes) return current;
      const used = new Set(current.probes.map((probe) => probe.family));
      const family = availableFamilies.find((option) => !used.has(option)) ?? availableFamilies[0];
      if (!family) return current;
      return {
        ...current,
        probes: [...current.probes, { family, destination: '', path: defaultProbePath(family) }],
      };
    });
  };

  const updateProbe = (index: number, next: Partial<TargetProbeForm>) => {
    setFormError(null);
    setForm((current) => ({
      ...current,
      probes: current.probes.map((probe, position) => (position === index ? { ...probe, ...next } : probe)),
    }));
  };

  const removeProbe = (index: number) => {
    setFormError(null);
    setForm((current) => ({
      ...current,
      probes: current.probes.filter((_, position) => position !== index),
    }));
  };

  const handleSubmit = async () => {
    setFormError(null);
    const validationKey = validateTargetForm(form, meta);
    if (validationKey) {
      setFormError(t(validationKey));
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'edit' && existing) {
        const payload = buildUpdateTargetRequest(existing.revision, form);
        await updateNfHealthTarget(existing.targetId, payload);
        onSaved(t('nf_health_feedback_updated'));
      } else {
        const payload = buildCreateTargetRequest(form);
        await createNfHealthTarget(payload);
        onSaved(t('nf_health_feedback_created'));
      }
      onClose();
    } catch (err) {
      const message = describeDialogError(err, t);
      setFormError(message);
      onFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = mode === 'edit' ? 'nf-health-edit-title' : 'nf-health-create-title';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      overlayClassName={`modal-overlay ${styles.modalOverlay}`}
      className={`modal-content animate-fade-in ${styles.modalContent}`}
      labelledBy={titleId}
    >
      <div className={styles.modalHeader}>
        <h2 id={titleId}>
          {mode === 'edit' ? t('nf_health_edit_target') : t('nf_health_add_target')}
        </h2>
      </div>
      <div className={styles.modalBody}>
        <p className={styles.modalIntro}>{t('nf_health_target_form_intro')}</p>

        {mode === 'create' ? (
          <Field
            htmlFor="nf-health-resource"
            label={t('nf_health_field_resource')}
            description={t('nf_health_field_resource_hint')}
          >
            <input
              id="nf-health-resource-search"
              className="form-input"
              type="search"
              value={resourceQuery}
              onChange={(event) => setResourceQuery(event.target.value)}
              placeholder={t('nf_health_field_resource_search')}
              aria-label={t('nf_health_field_resource_search')}
              disabled={submitting}
            />
            <select
              id="nf-health-resource"
              className="form-input"
              value={form.resourceId}
              onChange={(event) => {
                const nextId = event.target.value;
                const resource = resources.find((item) => item.resourceId === nextId);
                patch({
                  resourceId: nextId,
                  name: resource && !form.name.trim() ? resource.displayName || resource.name : form.name,
                  serviceUnit: resource ? resource.role || form.serviceUnit : form.serviceUnit,
                });
              }}
              disabled={submitting || resourcesLoading}
            >
              <option value="">
                {resourcesLoading ? t('loading') : t('nf_health_field_resource_placeholder')}
              </option>
              {resources.map((resource) => (
                <option key={resource.resourceId} value={resource.resourceId}>
                  {resource.displayName || resource.name} - {resource.domain}
                  {resource.role ? ` - ${resource.role}` : ''}
                </option>
              ))}
            </select>
            {resourcesHasMore && resourcesCursor ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => loadResources(resourceQuery, resourcesCursor, true)}
                disabled={submitting || resourcesLoading}
              >
                {t('nf_health_field_resource_load_more')}
              </button>
            ) : null}
          </Field>
        ) : (
          <Field htmlFor="nf-health-resource-view" label={t('nf_health_field_resource')}>
            <input
              id="nf-health-resource-view"
              className="form-input"
              value={existing?.resourceId ?? ''}
              readOnly
              disabled
            />
            {existing?.domain || existing?.nfType ? (
              <p className={styles.modalIntro}>
                {t('nf_health_field_resource_selected', {
                  domain: existing.domain ?? '-',
                  nfType: existing.nfType ?? '-',
                })}
              </p>
            ) : null}
            {existing && !existing.resourceId ? (
              <p className={styles.modalIntro}>{t('nf_health_identity_legacy_hint')}</p>
            ) : null}
          </Field>
        )}

        {selectedResource ? (
          <p className={styles.modalIntro}>
            {t('nf_health_field_resource_selected', {
              domain: selectedResource.domain,
              nfType: selectedResource.role || '-',
            })}
          </p>
        ) : null}

        <Field
          htmlFor="nf-health-candidate"
          label={t('nf_health_field_candidate')}
          description={t('nf_health_field_candidate_optional_hint')}
        >
          <select
            id="nf-health-candidate"
            className="form-input"
            value={form.candidateId}
            onChange={(event) => {
              const nextId = event.target.value;
              const candidate = candidates.find((item) => item.candidateId === nextId);
              patch({
                candidateId: nextId,
                name: candidate && !form.name.trim() ? `${candidate.nfType} ${candidate.externalNfInstanceId}`.trim() : form.name,
              });
            }}
            disabled={submitting || candidatesLoading}
          >
            <option value="">
              {candidatesLoading ? t('loading') : t('nf_health_field_candidate_none')}
            </option>
            {candidates.map((candidate) => (
              <option key={candidate.candidateId} value={candidate.candidateId}>
                {candidate.nfType} - {candidate.externalNfInstanceId}
              </option>
            ))}
          </select>
        </Field>

        {selectedCandidate ? (
          <p className={styles.modalIntro}>
            {t('nf_health_field_candidate_selected', {
              nfType: selectedCandidate.nfType,
              registryStatus: selectedCandidate.nfStatus,
            })}
          </p>
        ) : null}

        <Field htmlFor="nf-health-name" label={t('nf_health_field_name')}>
          <input
            id="nf-health-name"
            className="form-input"
            value={form.name}
            onChange={(event) => patch({ name: event.target.value })}
            disabled={submitting}
          />
        </Field>

        <div className={styles.formRow}>
          <Field
            htmlFor="nf-health-profile"
            label={t('nf_health_field_profile')}
            description={t('nf_health_field_profile_hint')}
          >
            <select
              id="nf-health-profile"
              className="form-input"
              value={form.collectorProfile}
              onChange={(event) => patch({ collectorProfile: event.target.value as typeof form.collectorProfile })}
              disabled={submitting || mode === 'edit'}
            >
              {(meta?.collectorProfiles ?? ['http_metrics']).map((value) => (
                <option key={value} value={value}>
                  {value === 'process_only'
                    ? t('nf_health_profile_process_only')
                    : t('nf_health_profile_http_metrics')}
                </option>
              ))}
            </select>
          </Field>

          <Field
            htmlFor="nf-health-mode"
            label={t('nf_health_field_mode')}
            description={t('nf_health_field_mode_hint')}
          >
            <select
              id="nf-health-mode"
              className="form-input"
              value={form.collectionMode}
              onChange={(event) => {
                const value = event.target.value;
                if (isCollectionMode(value)) patch({ collectionMode: value as CollectionMode });
              }}
              disabled={submitting}
            >
              {(meta?.collectionModes ?? ['manual', 'scheduled']).map((value) => (
                <option key={value} value={value}>
                  {value === 'manual' ? t('nf_health_mode_manual') : t('nf_health_mode_scheduled')}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {isProcessOnly ? (
          <p className={styles.modalIntro}>{t('nf_health_profile_process_only_note')}</p>
        ) : (
          <div className={styles.formRow}>
            <Field
              htmlFor="nf-health-destination"
              label={t('nf_health_field_destination')}
              description={t('nf_health_field_destination_hint')}
            >
              <select
                id="nf-health-destination"
                className="form-input"
                value={form.metricsDestination}
                onChange={(event) => patch({ metricsDestination: event.target.value })}
                disabled={submitting}
              >
                <option value="">{t('nf_health_field_destination_placeholder')}</option>
                {(meta?.allowedDestinations ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              htmlFor="nf-health-path"
              label={t('nf_health_field_path')}
              description={t('nf_health_field_path_hint')}
            >
              <input
                id="nf-health-path"
                className="form-input"
                value={form.metricsPath}
                onChange={(event) => patch({ metricsPath: event.target.value })}
                disabled={submitting}
                placeholder="/metrics"
              />
            </Field>
          </div>
        )}

        {isProcessOnly ? null : (
          <section className={styles.probeEditor} aria-label={t('nf_health_probes_label')}>
            <div className={styles.probeEditorHead}>
              <div>
                <strong>{t('nf_health_probes_label')}</strong>
                <p className={styles.probeEditorHint}>{t('nf_health_probes_hint')}</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={addProbe}
                disabled={submitting || form.probes.length >= maxProbes}
              >
                <Plus size={14} aria-hidden="true" />
                {t('nf_health_probes_add')}
              </button>
            </div>
            {form.probes.length === 0 ? (
              <p className={styles.probeEditorEmpty}>{t('nf_health_probes_empty')}</p>
            ) : (
              form.probes.map((probe, index) => (
                <div key={probe.family} className={styles.probeRow}>
                  <select
                    className="form-input"
                    aria-label={t('nf_health_probes_family')}
                    value={probe.family}
                    onChange={(event) =>
                      updateProbe(index, { family: event.target.value as ProbeFamily })
                    }
                    disabled={submitting}
                  >
                    {availableFamilies.map((family) => (
                      <option key={family} value={family}>
                        {t('nf_health_probe_family_' + family)}
                      </option>
                    ))}
                  </select>
                  <select
                    className="form-input"
                    aria-label={t('nf_health_field_destination')}
                    value={probe.destination}
                    onChange={(event) => updateProbe(index, { destination: event.target.value })}
                    disabled={submitting}
                  >
                    <option value="">{t('nf_health_field_destination_placeholder')}</option>
                    {(meta?.allowedDestinations ?? []).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <input
                    className="form-input"
                    aria-label={t('nf_health_field_path')}
                    value={probe.path}
                    onChange={(event) => updateProbe(index, { path: event.target.value })}
                    disabled={submitting}
                    placeholder={defaultProbePath(probe.family)}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => removeProbe(index)}
                    disabled={submitting}
                    aria-label={t('nf_health_probes_remove')}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              ))
            )}
          </section>
        )}

        <div className={styles.formRow}>
          <Field
            htmlFor="nf-health-service-unit"
            label={t('nf_health_field_service_unit')}
            description={t('nf_health_field_service_unit_hint')}
          >
            <select
              id="nf-health-service-unit"
              className="form-input"
              value={form.serviceUnit}
              onChange={(event) => patch({ serviceUnit: event.target.value })}
              disabled={submitting}
            >
              <option value="">{t('nf_health_field_service_unit_placeholder')}</option>
              {(meta?.allowedServiceUnits ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>

          <Field
            htmlFor="nf-health-service-kind"
            label={t('nf_health_field_service_kind')}
            description={t('nf_health_field_service_kind_hint')}
          >
            <select
              id="nf-health-service-kind"
              className="form-input"
              value={form.serviceKind}
              onChange={(event) => {
                const value = event.target.value;
                if (isServiceKind(value)) patch({ serviceKind: value as ServiceKind });
              }}
              disabled={submitting}
            >
              <option value="process">process</option>
              <option value="systemd">systemd</option>
              {!isProcessOnly ? <option value="none">none</option> : null}
            </select>
          </Field>
        </div>

        <div className={styles.formRow}>
          <Field
            htmlFor="nf-health-interval"
            label={t('nf_health_field_interval')}
            description={t('nf_health_field_interval_hint', {
              min: meta?.minIntervalSeconds ?? 60,
              max: meta?.maxIntervalSeconds ?? 3600,
            })}
          >
            <input
              id="nf-health-interval"
              className="form-input"
              type="number"
              min={meta?.minIntervalSeconds ?? 60}
              max={meta?.maxIntervalSeconds ?? 3600}
              value={form.intervalSeconds}
              onChange={(event) => patch({ intervalSeconds: Number(event.target.value) })}
              disabled={submitting}
            />
          </Field>

          <Field htmlFor="nf-health-enabled" label={t('nf_health_field_enabled')}>
            <input
              id="nf-health-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
              disabled={submitting}
            />
          </Field>
        </div>

        {formError ? (
          <p className={styles.formError} role="alert">
            {formError}
          </p>
        ) : null}
      </div>
      {/*
       * Action row lives outside the scrolling body so Close / Cancel / Create
       * remain reachable while the form content scrolls independently.
       */}
      <div className={styles.formActions}>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting ? t('nf_health_submitting') : mode === 'edit' ? t('save') : t('nf_health_create_confirm')}
        </button>
      </div>
    </Dialog>
  );
}

function describeDialogError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof Error && err.message && !err.message.startsWith('{')) {
    if (err.message.startsWith('nf_health_validation_')) {
      return t(err.message);
    }
    return err.message;
  }
  return t('nf_health_err_mutation');
}
