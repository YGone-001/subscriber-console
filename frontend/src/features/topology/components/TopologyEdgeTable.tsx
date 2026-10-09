/*
 * Relationship table.
 *
 * This is the primary equivalent semantic representation of the one-hop graph:
 * every relationship rendered as a node/edge in the visualization is present
 * here as an accessible, keyboard-navigable row. It is never a bare JSON dump.
 */
import { ArrowRight, Check, Copy, Eye, Pencil, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../providers/I18nProvider';
import type { ResourceProjection, TopologyEdge } from '../topology-types';
import { RELATIONSHIP_PRESENTATION } from '../topology-types';
import styles from '../../../styles/modules/topology.module.css';

export interface TopologyEdgeTableProps {
  edges: TopologyEdge[];
  directory: Record<string, ResourceProjection>;
  caption: string;
  rootResourceId?: string;
  selectedEdgeId?: string;
  canConfigure: boolean;
  onSelectEdge?: (edgeId: string) => void;
  onEdit?: (edge: TopologyEdge) => void;
  onRetire?: (edge: TopologyEdge) => void;
  onViewResource?: (resourceId: string) => void;
}

function CopyIdButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={styles.copyBtn}
      title={value}
      aria-label={`${t('topology_copy_id')}: ${value}`}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* Clipboard access can be denied; the identifier stays visible. */
        }
      }}
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

function EndpointCell({
  resourceId,
  projection,
  onView,
}: {
  resourceId: string;
  projection?: ResourceProjection;
  onView?: (resourceId: string) => void;
}) {
  const { t } = useI18n();
  const name = projection?.displayName || projection?.name;
  return (
    <div className={styles.endpoint}>
      <div className={styles.endpointName}>
        {name ? (
          onView ? (
            <button type="button" className={styles.linkBtn} onClick={() => onView(resourceId)}>
              {name}
            </button>
          ) : (
            <strong>{name}</strong>
          )
        ) : (
          <span className={styles.muted}>{t('topology_unresolved_resource')}</span>
        )}
        <CopyIdButton value={resourceId} />
      </div>
      <code className={styles.uuid} title={resourceId}>
        {resourceId}
      </code>
      {projection ? (
        <span className={styles.endpointMeta}>
          {projection.kind} · {projection.domain}
        </span>
      ) : null}
    </div>
  );
}

export function TopologyEdgeTable({
  edges,
  directory,
  caption,
  rootResourceId,
  selectedEdgeId,
  canConfigure,
  onSelectEdge,
  onEdit,
  onRetire,
  onViewResource,
}: TopologyEdgeTableProps) {
  const { t } = useI18n();

  const relationshipLabel = (value: string) => {
    const presentation = RELATIONSHIP_PRESENTATION[value];
    return presentation ? t(presentation.labelKey) : value;
  };

  const directionLabel = (edge: TopologyEdge) => {
    if (!rootResourceId) return null;
    if (edge.fromResourceId === rootResourceId) return t('topology_direction_outbound');
    if (edge.toResourceId === rootResourceId) return t('topology_direction_inbound');
    return null;
  };

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className={styles.fromCol} />
          <col className={styles.relCol} />
          <col className={styles.dirCol} />
          <col className={styles.toCol} />
          <col className={styles.stateCol} />
          <col className={styles.revCol} />
          <col className={styles.updatedCol} />
          <col className={styles.actionsCol} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t('topology_from_resource')}</th>
            <th scope="col">{t('topology_relationship')}</th>
            <th scope="col">{t('topology_direction')}</th>
            <th scope="col">{t('topology_to_resource')}</th>
            <th scope="col">{t('topology_lifecycle')}</th>
            <th scope="col">{t('topology_revision')}</th>
            <th scope="col">{t('topology_updated_at')}</th>
            <th scope="col" className={styles.actionsCell}>
              {t('actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => {
            const direction = directionLabel(edge);
            const retired = edge.lifecycleState === 'retired';
            return (
              <tr
                key={edge.edgeId}
                className={edge.edgeId === selectedEdgeId ? styles.rowSelected : undefined}
                onClick={onSelectEdge ? () => onSelectEdge(edge.edgeId) : undefined}
                data-edge-id={edge.edgeId}
              >
                <td>
                  <EndpointCell
                    resourceId={edge.fromResourceId}
                    projection={directory[edge.fromResourceId]}
                    onView={onViewResource}
                  />
                </td>
                <td>
                  <span className={styles.relBadge} data-relationship={edge.relationshipType}>
                    {relationshipLabel(edge.relationshipType)}
                  </span>
                </td>
                <td>
                  {direction ? (
                    <span className={styles.directionBadge}>{direction}</span>
                  ) : (
                    <ArrowRight size={14} className={styles.directionArrow} aria-hidden="true" />
                  )}
                </td>
                <td>
                  <EndpointCell
                    resourceId={edge.toResourceId}
                    projection={directory[edge.toResourceId]}
                    onView={onViewResource}
                  />
                </td>
                <td>
                  <span className={`badge ${retired ? 'badge-danger' : 'badge-success'}`}>
                    {retired ? t('topology_state_retired') : t('topology_state_active')}
                  </span>
                  <span className={styles.declaredNote}>{t('topology_declared_note')}</span>
                </td>
                <td>
                  <span className={styles.revision}>r{edge.revision}</span>
                </td>
                <td>
                  <span className={styles.dateCell}>{formatTimestamp(edge.updatedAt)}</span>
                </td>
                <td className={styles.actionsCell}>
                  <div className={styles.rowActions}>
                    {onSelectEdge ? (
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectEdge(edge.edgeId);
                        }}
                      >
                        <Eye size={14} aria-hidden="true" />
                        {t('topology_view_detail')}
                      </button>
                    ) : null}
                    {canConfigure && !retired && onEdit ? (
                      <button
                        type="button"
                        className={styles.rowAction}
                        onClick={(event) => {
                          event.stopPropagation();
                          onEdit(edge);
                        }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        {t('edit')}
                      </button>
                    ) : null}
                    {canConfigure && !retired && onRetire ? (
                      <button
                        type="button"
                        className={`${styles.rowAction} ${styles.rowActionDanger}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRetire(edge);
                        }}
                      >
                        <RotateCcw size={14} aria-hidden="true" />
                        {t('topology_retire')}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default TopologyEdgeTable;
