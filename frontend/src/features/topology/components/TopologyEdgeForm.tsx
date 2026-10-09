/*
 * Create / edit relationship form.
 *
 * Reuses the shared dialog form primitives (Field, form-input, btn). Identity is
 * immutable: in edit mode the from/relationship/to tuple and the revision are
 * displayed read-only and only description/labels/attributes are editable.
 *
 * Both submit paths go through the production request builders so the payload
 * shape cannot drift from the validated contract.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Field } from '../../../components/ui/Field';
import type { Resource } from '../../inventory/inventory-types';
import { useI18n } from '../../../providers/I18nProvider';
import { buildCreateEdgeRequest, buildUpdateEdgeRequest } from '../topology-builders';
import type { CreateEdgeRequest, TopologyEdge, UpdateEdgeRequest } from '../topology-types';
import { RELATIONSHIP_PRESENTATION } from '../topology-types';
import { primeResourceDirectory } from '../use-resource-directory';
import { TopologyResourcePicker } from './TopologyResourcePicker';
import styles from '../../../styles/modules/topology.module.css';

interface LabelRow {
  key: string;
  value: string;
}

export interface TopologyEdgeFormProps {
  mode: 'create' | 'edit';
  relationshipTypes: string[];
  initialEdge?: TopologyEdge;
  submitting: boolean;
  serverError: string | null;
  onCancel: () => void;
  onCreate?: (req: CreateEdgeRequest) => void;
  onUpdate?: (req: UpdateEdgeRequest) => void;
}

function rowsToLabels(rows: LabelRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) result[key] = row.value.trim();
  }
  return result;
}

function labelsToRows(labels?: Record<string, string>): LabelRow[] {
  if (!labels) return [];
  return Object.entries(labels).map(([key, value]) => ({ key, value }));
}

export function TopologyEdgeForm({
  mode,
  relationshipTypes,
  initialEdge,
  submitting,
  serverError,
  onCancel,
  onCreate,
  onUpdate,
}: TopologyEdgeFormProps) {
  const { t } = useI18n();

  const [fromResource, setFromResource] = useState<Resource | null>(null);
  const [toResource, setToResource] = useState<Resource | null>(null);
  const [relationshipType, setRelationshipType] = useState(
    initialEdge?.relationshipType ?? relationshipTypes[0] ?? '',
  );
  const [description, setDescription] = useState(initialEdge?.description ?? '');
  const [labelRows, setLabelRows] = useState<LabelRow[]>(labelsToRows(initialEdge?.labels));
  const [attributesJson, setAttributesJson] = useState(
    initialEdge?.attributes && Object.keys(initialEdge.attributes).length > 0
      ? JSON.stringify(initialEdge.attributes, null, 2)
      : '{}',
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const relationshipLabel = (value: string) => {
    const presentation = RELATIONSHIP_PRESENTATION[value];
    return presentation ? t(presentation.labelKey) : value;
  };

  const parseAttributes = (): Record<string, unknown> | undefined => {
    const raw = attributesJson.trim();
    if (!raw || raw === '{}') return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(t('topology_attributes_object_error'));
    }
    return parsed as Record<string, unknown>;
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setValidationError(null);
    try {
      const labels = rowsToLabels(labelRows);
      const attributes = parseAttributes();

      if (mode === 'create') {
        const req = buildCreateEdgeRequest({
          relationshipType,
          fromResourceId: fromResource?.resourceId,
          toResourceId: toResource?.resourceId,
          description: description || undefined,
          labels: Object.keys(labels).length > 0 ? labels : undefined,
          attributes,
        });
        primeResourceDirectory([fromResource as Resource, toResource as Resource]);
        onCreate?.(req);
        return;
      }

      if (!initialEdge) {
        throw new Error(t('topology_edit_missing_edge'));
      }
      const req = buildUpdateEdgeRequest(initialEdge.revision, {
        description,
        labels,
        attributes,
      });
      onUpdate?.(req);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {mode === 'create' ? (
        <>
          <TopologyResourcePicker
            id="topology-from-resource"
            label={t('topology_from_resource')}
            value={fromResource?.resourceId ?? ''}
            onChange={setFromResource}
            excludeResourceId={toResource?.resourceId}
            disabled={submitting}
          />
          <Field
            htmlFor="topology-relationship"
            label={t('topology_relationship')}
            description={t('topology_direction_hint')}
          >
            <select
              id="topology-relationship"
              className="form-input"
              value={relationshipType}
              onChange={(event) => setRelationshipType(event.target.value)}
              disabled={submitting}
            >
              {relationshipTypes.map((value) => (
                <option key={value} value={value}>
                  {relationshipLabel(value)}
                </option>
              ))}
            </select>
          </Field>
          <TopologyResourcePicker
            id="topology-to-resource"
            label={t('topology_to_resource')}
            value={toResource?.resourceId ?? ''}
            onChange={setToResource}
            excludeResourceId={fromResource?.resourceId}
            disabled={submitting}
          />
          <p className={styles.directionPreview} aria-live="polite">
            {fromResource ? fromResource.displayName || fromResource.name : t('topology_select_from')}
            <span aria-hidden="true"> → </span>
            <span className="sr-only">{relationshipLabel(relationshipType)}</span>
            {toResource ? toResource.displayName || toResource.name : t('topology_select_to')}
          </p>
        </>
      ) : initialEdge ? (
        <dl className={styles.identityReadonly}>
          <div>
            <dt>{t('topology_relationship')}</dt>
            <dd>{relationshipLabel(initialEdge.relationshipType)}</dd>
          </div>
          <div>
            <dt>{t('topology_from_resource')}</dt>
            <dd><code className={styles.uuid}>{initialEdge.fromResourceId}</code></dd>
          </div>
          <div>
            <dt>{t('topology_to_resource')}</dt>
            <dd><code className={styles.uuid}>{initialEdge.toResourceId}</code></dd>
          </div>
          <div>
            <dt>{t('topology_revision')}</dt>
            <dd>r{initialEdge.revision}</dd>
          </div>
        </dl>
      ) : null}

      <Field htmlFor="topology-description" label={t('topology_edge_description')}>
        <textarea
          id="topology-description"
          className="form-input"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t('topology_edge_description_placeholder')}
          disabled={submitting}
        />
      </Field>

      <fieldset className={styles.labelSet}>
        <legend>{t('topology_labels')}</legend>
        {labelRows.map((row, index) => (
          <div className={styles.labelRow} key={`label-${index}`}>
            <input
              className="form-input"
              aria-label={t('topology_label_key')}
              value={row.key}
              onChange={(event) => {
                const next = [...labelRows];
                next[index] = { ...next[index], key: event.target.value };
                setLabelRows(next);
              }}
              disabled={submitting}
            />
            <input
              className="form-input"
              aria-label={t('topology_label_value')}
              value={row.value}
              onChange={(event) => {
                const next = [...labelRows];
                next[index] = { ...next[index], value: event.target.value };
                setLabelRows(next);
              }}
              disabled={submitting}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setLabelRows(labelRows.filter((_, i) => i !== index))}
              disabled={submitting}
              aria-label={t('topology_remove_label')}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setLabelRows([...labelRows, { key: '', value: '' }])}
          disabled={submitting}
        >
          <Plus size={14} aria-hidden="true" />
          {t('topology_add_label')}
        </button>
      </fieldset>

      <Field
        htmlFor="topology-attributes"
        label={t('topology_attributes')}
        description={t('topology_attributes_hint')}
      >
        <textarea
          id="topology-attributes"
          className="form-input"
          rows={4}
          value={attributesJson}
          onChange={(event) => setAttributesJson(event.target.value)}
          disabled={submitting}
        />
      </Field>

      {validationError ? (
        <p className={styles.formError} role="alert">{validationError}</p>
      ) : null}
      {serverError ? (
        <p className={styles.formError} role="alert">{serverError}</p>
      ) : null}

      <div className={styles.formActions}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={submitting}>
          {t('cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting
            ? t('topology_submitting')
            : mode === 'create'
              ? t('topology_create_submit')
              : t('save')}
        </button>
      </div>
    </form>
  );
}

export default TopologyEdgeForm;
