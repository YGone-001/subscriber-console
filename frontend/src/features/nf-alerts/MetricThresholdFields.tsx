import { useEffect, useState } from 'react';
import { Field } from '../../components/ui/Field';
import { useI18n } from '../../providers/I18nProvider';
import { fetchNfHealthTarget } from '../nf-health/nf-health-api';
import type { GetTargetResponse } from '../nf-health/nf-health-types';
import type { MetricForm } from './metric-threshold';

export function MetricThresholdFields({ targetId, value, onChange, disabled, readOnly }: {
  targetId: string; value: MetricForm; onChange: (next: MetricForm) => void; disabled: boolean; readOnly: boolean;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ targetId: string; data?: GetTargetResponse; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!targetId) return;
    let active = true;
    fetchNfHealthTarget(targetId).then((data) => { if (active) setPreview({ targetId, data }); })
      .catch(() => { if (active) setPreview({ targetId, failed: true }); });
    return () => { active = false; };
  }, [targetId]);
  const current = preview?.targetId === targetId ? preview : null;
  const measured = current?.data?.thresholdPreview;
  return <section aria-label={t('nf_metric_title')}>
    <p>{t('nf_metric_note')}</p>
    <Field htmlFor="nf-metric-name" label={t('nf_metric_metric')}>
      <input id="nf-metric-name" className="form-input" readOnly value="process_resident_memory_bytes" />
    </Field>
    <p role="status">{!targetId ? t('nf_metric_target_required') : !current ? t('loading') : current.failed
      ? t('nf_metric_preview_failed') : measured?.value != null
        ? t('nf_metric_current', { value: measured.value, at: current.data?.latestSample?.collectedAt ?? '-' })
        : t(`nf_metric_reason_${measured?.reason ?? 'measurement_missing'}`)}</p>
    <Field htmlFor="nf-metric-operator" label={t('nf_metric_operator')}>
      <select id="nf-metric-operator" className="form-input" value={value.operator} disabled={disabled || readOnly}
        onChange={(event) => onChange({ ...value, operator: event.target.value as MetricForm['operator'] })}>
        {(['gt', 'gte', 'lt', 'lte'] as const).map((op) => <option key={op} value={op}>{t(`nf_metric_op_${op}`)}</option>)}
      </select>
    </Field>
    <Field htmlFor="nf-metric-threshold" label={t('nf_metric_threshold')}>
      <input id="nf-metric-threshold" className="form-input" type="number" min="0" step="any" value={value.threshold}
        disabled={disabled || readOnly} onChange={(event) => onChange({ ...value, threshold: event.target.value })} />
    </Field>
    <Field htmlFor="nf-metric-recovery" label={t('nf_metric_recovery')} description={t('nf_metric_recovery_hint')}>
      <input id="nf-metric-recovery" className="form-input" type="number" min="0" step="any" value={value.recoveryThreshold}
        disabled={disabled || readOnly} onChange={(event) => onChange({ ...value, recoveryThreshold: event.target.value })} />
    </Field>
    <p>{t(readOnly ? 'nf_metric_immutable' : 'nf_metric_immediate')}</p>
  </section>;
}
