/*
 * NF Health monitoring target form dialog.
 *
 * Covers add and edit paths for an approved monitoring target. Destinations,
 * collector profiles and service units are constrained to the server-owned
 * metadata allowlists; free-form shell commands are never accepted.
 */
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { useI18n } from '../../providers/I18nProvider';
import { fetchDiscoveryCandidates } from '../discovery/discovery-api';
import type { NfObservation } from '../discovery/discovery-types';
import { createNfHealthTarget, updateNfHealthTarget } from './nf-health-api';
import {
  buildCreateTargetRequest,
  buildUpdateTargetRequest,
  createEmptyTargetForm,
  splitMetricsEndpoint,
  type NfHealthTargetForm,
} from './nf-health-builders';
import { isCollectionMode, isServiceKind, validateTargetForm } from './nf-health-validation';
import type {
  CollectionMode,
  HealthTarget,
  NfHealthMeta,
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
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    if (mode === 'edit' && existing) {
      const split = splitMetricsEndpoint(existing.metricsEndpoint);
      setForm({
        candidateId: existing.candidateId,
        name: existing.name,
        collectorProfile: existing.collectorProfile,
        metricsDestination: split.destination,
        metricsPath: split.path,
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

  const selectedCandidate = useMemo(
    () => candidates.find((item) => item.candidateId === form.candidateId) ?? null,
    [candidates, form.candidateId],
  );

  const patch = (next: Partial<NfHealthTargetForm>) => {
    setForm((current) => ({ ...current, ...next }));
    setFormError(null);
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
            htmlFor="nf-health-candidate"
            label={t('nf_health_field_candidate')}
            description={t('nf_health_field_candidate_hint')}
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
                  name: candidate ? `${candidate.nfType} ${candidate.externalNfInstanceId}`.trim() : form.name,
                });
              }}
              disabled={submitting || candidatesLoading}
            >
              <option value="">
                {candidatesLoading ? t('loading') : t('nf_health_field_candidate_placeholder')}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.candidateId} value={candidate.candidateId}>
                  {candidate.nfType} - {candidate.externalNfInstanceId}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field htmlFor="nf-health-candidate-view" label={t('nf_health_field_candidate')}>
            <input
              id="nf-health-candidate-view"
              className="form-input"
              value={existing?.candidateId ?? ''}
              readOnly
              disabled
            />
          </Field>
        )}

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
              onChange={(event) => patch({ collectorProfile: event.target.value })}
              disabled={submitting || mode === 'edit'}
            >
              {(meta?.collectorProfiles ?? ['http_metrics']).map((value) => (
                <option key={value} value={value}>
                  {value}
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
              <option value="none">none</option>
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
