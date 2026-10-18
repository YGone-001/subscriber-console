/*
 * NF alert rule form dialog (create and edit).
 *
 * The scope identity (targetId / resourceId) is immutable on edit: retargeting
 * a rule would silently move its open alerts to another subject. The cooldown
 * window bounds come from the server-owned metadata vocabulary.
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Field } from '../../components/ui/Field';
import { useI18n } from '../../providers/I18nProvider';
import { MutationApiError } from '../../lib/api/mutation-client';
import { createNfAlertRule, updateNfAlertRule } from './nf-alerts-api';
import type {
  AlertRule,
  AlertSeverity,
  ConditionScope,
  ConditionType,
  NfAlertsMeta,
  RuleCondition,
  StateConditionValue,
} from './nf-alerts-types';
import styles from '../../styles/modules/nf-alerts.module.css';

type Props = {
  open: boolean;
  meta: NfAlertsMeta | null;
  rule: AlertRule | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onFormError: (message: string) => void;
};

export function NfAlertRuleDialog({ open, meta, rule, onClose, onSaved, onFormError }: Props) {
  const { t } = useI18n();
  const isEdit = rule !== null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [targetId, setTargetId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [conditionType, setConditionType] = useState<ConditionType>('state');
  const [scope, setScope] = useState<ConditionScope>('overall');
  const [state, setState] = useState<StateConditionValue>('unhealthy');
  const [severity, setSeverity] = useState<AlertSeverity>('warning');
  const [cooldownSeconds, setCooldownSeconds] = useState(300);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    if (rule) {
      setName(rule.name);
      setDescription(rule.description ?? '');
      setEnabled(rule.enabled);
      setTargetId(rule.targetId ?? '');
      setResourceId(rule.resourceId ?? '');
      setConditionType(rule.conditionType);
      setScope(rule.condition?.scope ?? 'overall');
      setState(rule.condition?.state ?? 'unhealthy');
      setSeverity(rule.severity);
      setCooldownSeconds(rule.cooldownSeconds);
    } else {
      setName('');
      setDescription('');
      setEnabled(true);
      setTargetId('');
      setResourceId('');
      setConditionType('state');
      setScope('overall');
      setState('unhealthy');
      setSeverity('warning');
      setCooldownSeconds(meta?.defaultCooldownSeconds ?? 300);
    }
  }, [open, rule, meta]);

  const minCooldown = meta?.minCooldownSeconds ?? 60;
  const maxCooldown = meta?.maxCooldownSeconds ?? 86400;

  const handleSubmit = async () => {
    setFormError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      const message = t('nf_alerts_err_name_required');
      setFormError(message);
      return;
    }
    const trimmedTarget = targetId.trim();
    const trimmedResource = resourceId.trim();
    if (trimmedTarget && trimmedResource) {
      const message = t('nf_alerts_err_scope_exclusive');
      setFormError(message);
      return;
    }
    const condition: RuleCondition | undefined =
      conditionType === 'state' ? { scope, state } : undefined;

    setSubmitting(true);
    try {
      if (isEdit && rule) {
        await updateNfAlertRule(rule.ruleId, {
          expectedRevision: rule.revision,
          rule: {
            name: trimmedName,
            description: description.trim() || undefined,
            enabled,
            conditionType,
            condition,
            severity,
            cooldownSeconds,
          },
        });
        onSaved(t('nf_alerts_feedback_rule_updated'));
      } else {
        await createNfAlertRule({
          name: trimmedName,
          description: description.trim() || undefined,
          enabled,
          targetId: trimmedTarget || undefined,
          resourceId: trimmedResource || undefined,
          conditionType,
          condition,
          severity,
          cooldownSeconds,
        });
        onSaved(t('nf_alerts_feedback_rule_created'));
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

  const titleId = isEdit ? 'nf-alerts-edit-title' : 'nf-alerts-create-title';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      overlayClassName="modal-overlay"
      className="modal-content animate-fade-in"
      labelledBy={titleId}
    >
      <div className={styles.modalHeader}>
        <h2 id={titleId}>{isEdit ? t('nf_alerts_edit_rule') : t('nf_alerts_add_rule')}</h2>
      </div>
      <div className={styles.modalBody}>
        <p className={styles.modalIntro}>{t('nf_alerts_dialog_note')}</p>

        <Field htmlFor="nf-alerts-name" label={t('nf_alerts_field_name')}>
          <input
            id="nf-alerts-name"
            className="form-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={submitting}
            maxLength={120}
          />
        </Field>

        <Field
          htmlFor="nf-alerts-description"
          label={t('nf_alerts_field_description')}
          description={t('nf_alerts_field_description_hint')}
        >
          <input
            id="nf-alerts-description"
            className="form-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={submitting}
            maxLength={500}
          />
        </Field>

        {isEdit ? (
          <p className={styles.modalIntro}>{t('nf_alerts_scope_immutable')}</p>
        ) : (
          <div className={styles.formRow}>
            <Field
              htmlFor="nf-alerts-target"
              label={t('nf_alerts_field_target_id')}
              description={t('nf_alerts_field_target_hint')}
            >
              <input
                id="nf-alerts-target"
                className="form-input"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                disabled={submitting}
                placeholder={t('nf_alerts_field_target_placeholder')}
              />
            </Field>

            <Field
              htmlFor="nf-alerts-resource"
              label={t('nf_alerts_field_resource_id')}
              description={t('nf_alerts_field_resource_hint')}
            >
              <input
                id="nf-alerts-resource"
                className="form-input"
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
                disabled={submitting}
                placeholder={t('nf_alerts_field_resource_placeholder')}
              />
            </Field>
          </div>
        )}

        <div className={styles.formRow}>
          <Field
            htmlFor="nf-alerts-condition-type"
            label={t('nf_alerts_field_condition_type')}
            description={t('nf_alerts_field_condition_type_hint')}
          >
            <select
              id="nf-alerts-condition-type"
              className="form-input"
              value={conditionType}
              onChange={(event) => setConditionType(event.target.value as ConditionType)}
              disabled={submitting}
            >
              <option value="state">{t('nf_alerts_condition_state')}</option>
              <option value="run_failed">{t('nf_alerts_condition_run_failed')}</option>
            </select>
          </Field>

          {conditionType === 'state' ? (
            <>
              <Field
                htmlFor="nf-alerts-scope"
                label={t('nf_alerts_field_scope')}
                description={t('nf_alerts_field_scope_hint')}
              >
                <select
                  id="nf-alerts-scope"
                  className="form-input"
                  value={scope}
                  onChange={(event) => setScope(event.target.value as ConditionScope)}
                  disabled={submitting}
                >
                  <option value="overall">{t('nf_alerts_scope_overall')}</option>
                  <option value="process">{t('nf_alerts_scope_process')}</option>
                  <option value="interface">{t('nf_alerts_scope_interface')}</option>
                  <option value="service">{t('nf_alerts_scope_service')}</option>
                </select>
              </Field>

              <Field
                htmlFor="nf-alerts-state"
                label={t('nf_alerts_field_state')}
                description={t('nf_alerts_field_state_hint')}
              >
                <select
                  id="nf-alerts-state"
                  className="form-input"
                  value={state}
                  onChange={(event) => setState(event.target.value as StateConditionValue)}
                  disabled={submitting}
                >
                  <option value="unhealthy">{t('nf_alerts_state_unhealthy')}</option>
                  <option value="degraded">{t('nf_alerts_state_degraded')}</option>
                  <option value="unknown">{t('nf_alerts_state_unknown')}</option>
                </select>
              </Field>
            </>
          ) : null}
        </div>

        <div className={styles.formRow}>
          <Field htmlFor="nf-alerts-severity" label={t('nf_alerts_field_severity')}>
            <select
              id="nf-alerts-severity"
              className="form-input"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as AlertSeverity)}
              disabled={submitting}
            >
              <option value="critical">{t('nf_alerts_severity_critical')}</option>
              <option value="warning">{t('nf_alerts_severity_warning')}</option>
              <option value="info">{t('nf_alerts_severity_info')}</option>
            </select>
          </Field>

          <Field
            htmlFor="nf-alerts-cooldown"
            label={t('nf_alerts_field_cooldown')}
            description={t('nf_alerts_cooldown_hint', { min: minCooldown, max: maxCooldown })}
          >
            <input
              id="nf-alerts-cooldown"
              className="form-input"
              type="number"
              min={minCooldown}
              max={maxCooldown}
              step={30}
              value={cooldownSeconds}
              onChange={(event) => setCooldownSeconds(Number(event.target.value))}
              disabled={submitting}
            />
          </Field>
        </div>

        <Field htmlFor="nf-alerts-enabled" label={t('nf_alerts_field_enabled')}>
          <input
            id="nf-alerts-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            disabled={submitting}
          />
        </Field>

        {formError ? (
          <p className={styles.formError} role="alert">
            {formError}
          </p>
        ) : null}
      </div>
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
          {submitting ? t('nf_alerts_submitting') : isEdit ? t('save') : t('nf_alerts_create_rule')}
        </button>
      </div>
    </Dialog>
  );
}

function describeDialogError(
  err: unknown,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (err instanceof MutationApiError) {
    switch (err.code) {
      case 'NF_ALERT_RULE_NOT_FOUND':
        return t('nf_alerts_err_rule_not_found');
      case 'NF_ALERT_REVISION_CONFLICT':
        return t('nf_alerts_err_revision_conflict');
      default:
        return err.message;
    }
  }
  return err instanceof Error && err.message ? err.message : t('nf_alerts_err_mutation');
}
