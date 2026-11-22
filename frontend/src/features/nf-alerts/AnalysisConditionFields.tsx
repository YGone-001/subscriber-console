import { Field } from '../../components/ui/Field';
import { useI18n } from '../../providers/I18nProvider';
import type { AnalysisForm, AnalysisPolicy } from './metric-analysis-form';

// The analysis rule form pins the frozen server policy. It never lets the
// operator type an algorithm or policy version: the server rejects anything
// else, so the form only offers what the deployment advertises.
export function AnalysisConditionFields({ value, onChange, disabled, readOnly, policy }: {
  value: AnalysisForm; onChange: (next: AnalysisForm) => void; disabled: boolean; readOnly: boolean; policy?: AnalysisPolicy;
}) {
  const { t } = useI18n();
  const trend = value.kind === 'trend';
  return <section aria-label={t('nf_analysis_rule_title')}>
    <p>{t('nf_analysis_rule_note')}</p>
    <Field htmlFor="nf-analysis-kind" label={t('nf_analysis_rule_kind')}>
      <select id="nf-analysis-kind" className="form-input" value={value.kind} disabled={disabled || readOnly}
        onChange={(event) => onChange({ ...value, kind: event.target.value as AnalysisForm['kind'] })}>
        <option value="trend">{t('nf_analysis_rule_kind_trend')}</option>
        <option value="baseline">{t('nf_analysis_rule_kind_deviation')}</option>
      </select>
    </Field>
    <Field htmlFor="nf-analysis-direction" label={t('nf_analysis_rule_direction')}>
      <select id="nf-analysis-direction" className="form-input" value={value.direction} disabled={disabled || readOnly}
        onChange={(event) => onChange({ ...value, direction: event.target.value as AnalysisForm['direction'] })}>
        <option value="rising">{t('nf_analysis_rule_direction_rising')}</option>
        <option value="falling">{t('nf_analysis_rule_direction_falling')}</option>
        {trend ? null : <option value="">{t('nf_analysis_rule_direction_any')}</option>}
      </select>
    </Field>
    <p role="status">{policy
      ? t(trend ? 'nf_analysis_rule_trend_policy' : 'nf_analysis_rule_deviation_policy', {
        algorithm: trend ? policy.trendAlgorithm : policy.deviationAlgorithm,
        policy: trend ? policy.trendPolicy : policy.deviationPolicy,
      })
      : t('nf_analysis_rule_unavailable')}</p>
    <p>{t('nf_analysis_rule_shadow_note', { freshness: policy?.freshnessSeconds ?? 0, confirmations: policy?.recoveryConfirmations ?? 0 })}</p>
  </section>;
}
