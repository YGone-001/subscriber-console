/*
 * Selected relationship detail.
 *
 * Presents the complete edge record including its immutable identity, the
 * server-owned provenance and the mutable metadata. It states explicitly that
 * the declared topology state is not an observed operational state.
 */
import { ExternalLink, Pencil, RotateCcw } from 'lucide-react';
import { useI18n } from '../../../providers/I18nProvider';
import type { ResourceProjection, TopologyEdge } from '../topology-types';
import { RELATIONSHIP_PRESENTATION } from '../topology-types';
import styles from '../../../styles/modules/topology.module.css';

export interface TopologyEdgeDetailProps {
  edge: TopologyEdge | null;
  directory: Record<string, ResourceProjection>;
  canConfigure: boolean;
  onViewResource?: (resourceId: string) => void;
  onEdit?: (edge: TopologyEdge) => void;
  onRetire?: (edge: TopologyEdge) => void;
}

function resourceName(projection: ResourceProjection | undefined, fallback: string): string {
  return projection?.displayName || projection?.name || fallback;
}

export function TopologyEdgeDetail({
  edge,
  directory,
  canConfigure,
  onViewResource,
  onEdit,
  onRetire,
}: TopologyEdgeDetailProps) {
  const { t } = useI18n();

  if (!edge) {
    return (
      <aside className={styles.detailPanel} aria-live="polite">
        <p className={styles.detailEmpty}>{t('topology_detail_empty')}</p>
      </aside>
    );
  }

  const presentation = RELATIONSHIP_PRESENTATION[edge.relationshipType];
  const relationshipLabel = presentation ? t(presentation.labelKey) : edge.relationshipType;
  const retired = edge.lifecycleState === 'retired';

  return (
    <aside className={styles.detailPanel} aria-label={t('topology_detail_title')}>
      <header className={styles.detailHeader}>
        <h3>{t('topology_detail_title')}</h3>
        <span className={`badge ${retired ? 'badge-danger' : 'badge-success'}`}>
          {retired ? t('topology_state_retired') : t('topology_state_active')}
        </span>
      </header>

      <p className={styles.declaredNotice}>{t('topology_declared_notice')}</p>

      <dl className={styles.detailList}>
        <div>
          <dt>{t('topology_edge_id')}</dt>
          <dd><code className={styles.uuid}>{edge.edgeId}</code></dd>
        </div>
        <div>
          <dt>{t('topology_relationship')}</dt>
          <dd>{relationshipLabel}</dd>
        </div>
        <div>
          <dt>{t('topology_from_resource')}</dt>
          <dd>
            <span>{resourceName(directory[edge.fromResourceId], t('topology_unresolved_resource'))}</span>
            <code className={styles.uuid}>{edge.fromResourceId}</code>
            {onViewResource ? (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => onViewResource(edge.fromResourceId)}
              >
                <ExternalLink size={12} aria-hidden="true" />
                {t('topology_open_resource')}
              </button>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t('topology_to_resource')}</dt>
          <dd>
            <span>{resourceName(directory[edge.toResourceId], t('topology_unresolved_resource'))}</span>
            <code className={styles.uuid}>{edge.toResourceId}</code>
            {onViewResource ? (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => onViewResource(edge.toResourceId)}
              >
                <ExternalLink size={12} aria-hidden="true" />
                {t('topology_open_resource')}
              </button>
            ) : null}
          </dd>
        </div>
        {edge.description ? (
          <div>
            <dt>{t('topology_edge_description')}</dt>
            <dd>{edge.description}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('topology_labels')}</dt>
          <dd>
            {edge.labels && Object.keys(edge.labels).length > 0 ? (
              <ul className={styles.metaList}>
                {Object.entries(edge.labels).map(([key, value]) => (
                  <li key={key}>
                    <code>{key}</code> = {value}
                  </li>
                ))}
              </ul>
            ) : (
              <span className={styles.muted}>{t('topology_none')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('topology_attributes')}</dt>
          <dd>
            {edge.attributes && Object.keys(edge.attributes).length > 0 ? (
              <pre className={styles.attributeBlock}>{JSON.stringify(edge.attributes, null, 2)}</pre>
            ) : (
              <span className={styles.muted}>{t('topology_none')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('topology_provenance')}</dt>
          <dd>
            {edge.source.kind} · {edge.source.system} · {edge.source.authority}
          </dd>
        </div>
        <div>
          <dt>{t('topology_revision')}</dt>
          <dd>r{edge.revision}</dd>
        </div>
        <div>
          <dt>{t('topology_created')}</dt>
          <dd>{edge.createdAt} · {edge.createdBy}</dd>
        </div>
        <div>
          <dt>{t('topology_updated')}</dt>
          <dd>{edge.updatedAt} · {edge.updatedBy}</dd>
        </div>
      </dl>

      {canConfigure && !retired ? (
        <div className={styles.detailActions}>
          {onEdit ? (
            <button type="button" className="btn btn-secondary" onClick={() => onEdit(edge)}>
              <Pencil size={14} aria-hidden="true" />
              {t('edit')}
            </button>
          ) : null}
          {onRetire ? (
            <button type="button" className="btn btn-danger" onClick={() => onRetire(edge)}>
              <RotateCcw size={14} aria-hidden="true" />
              {t('topology_retire')}
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export default TopologyEdgeDetail;
