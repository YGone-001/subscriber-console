/*
 * Interactive canvas for declared, Inventory-backed topology relationships.
 * Labels are intentionally conditional: the graph begins as a readable map,
 * then exposes relationship names for the focused or hovered path.
 */
import { useMemo } from 'react';
import { useI18n } from '../../../providers/I18nProvider';
import { RELATIONSHIP_PRESENTATION } from '../topology-types';
import {
  ACTUAL_BAND_HEADER_HEIGHT,
  ACTUAL_CANVAS_PADDING,
  ACTUAL_GROUP_LABEL_KEYS,
  ACTUAL_NODE_HEIGHT,
  ACTUAL_NODE_WIDTH,
  nodeMatches,
  type ActualTopologyLayout,
  type ActualTopologyNode,
} from '../actual-topology-model';
import { edgeGeometry, placeEdgeLabels } from '../actual-topology-labels';
import { nodeHealthLabelKey, type NodeHealth, type NodeHealthState } from '../actual-topology-health';
import { nfRoleLabel } from '../nf-classification';
import styles from '../../../styles/modules/architecture.module.css';

function nodeName(node: ActualTopologyNode): string {
  return node.displayName || node.name || node.resourceId;
}

function nodeRole(node: ActualTopologyNode): string {
  if (node.role) return nfRoleLabel(node.role);
  return node.kind ? node.kind.toUpperCase() : 'RESOURCE';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(1, max - 3))}...` : value;
}

function domainLabel(domain: string): string {
  return domain ? domain.toUpperCase() : '';
}

function healthDotClass(state: NodeHealthState): string {
  switch (state) {
    case 'healthy': return styles.actualHealthHealthy;
    case 'degraded': return styles.actualHealthDegraded;
    case 'unhealthy': return styles.actualHealthUnhealthy;
    case 'stale': return styles.actualHealthStale;
    case 'not_configured': return styles.actualHealthNotConfigured;
    case 'disabled': return styles.actualHealthDisabled;
    case 'not_monitored': return styles.actualHealthNotMonitored;
    case 'unresolved': return styles.actualHealthUnresolved;
    default: return styles.actualHealthUnknown;
  }
}

export function ActualTopologyCanvas({
  layout,
  selectedResourceId,
  search,
  hoveredEdgeId,
  health,
  onSelectResource,
  onHoverEdge,
}: {
  layout: ActualTopologyLayout;
  selectedResourceId?: string;
  search: string;
  hoveredEdgeId?: string;
  health?: ReadonlyMap<string, NodeHealth>;
  onSelectResource: (resourceId: string) => void;
  onHoverEdge: (edgeId?: string) => void;
}) {
  const { t } = useI18n();
  const relatedIds = useMemo(() => {
    if (!selectedResourceId) return new Set<string>();
    return new Set(
      layout.links
        .filter((link) => link.fromResourceId === selectedResourceId || link.toResourceId === selectedResourceId)
        .flatMap((link) => [link.fromResourceId, link.toResourceId]),
    );
  }, [layout.links, selectedResourceId]);
  const isFocused = (node: ActualTopologyNode) => !selectedResourceId || relatedIds.has(node.resourceId);
  const labels = useMemo(() => {
    if (!selectedResourceId && !hoveredEdgeId) return [];
    const relatedLinks = layout.links.filter((link) => {
      const related = Boolean(selectedResourceId)
        && (link.fromResourceId === selectedResourceId || link.toResourceId === selectedResourceId);
      return related || link.edgeId === hoveredEdgeId;
    });
    const text = new Map<string, string>();
    for (const link of relatedLinks) {
      const presentation = RELATIONSHIP_PRESENTATION[link.relationshipType];
      text.set(link.edgeId, presentation ? t(presentation.labelKey) : link.relationshipType);
    }
    return placeEdgeLabels(relatedLinks, text, layout.nodes, layout.width, layout.height);
  }, [layout.links, layout.nodes, layout.width, layout.height, selectedResourceId, hoveredEdgeId, t]);

  return (
    <svg
      className={styles.actualCanvas}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="group"
      aria-label={t('topology_title')}
      preserveAspectRatio="xMidYMid meet"
      data-actual-canvas="true"
    >
      <title>{t('topology_title')}</title>
      <defs>
        <marker id="actual-topology-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" className={styles.actualArrow} />
        </marker>
      </defs>

      {layout.bands.map((band) => (
        <g key={`${band.kind}-${band.domain ?? 'none'}`} aria-hidden="true">
          <text
            x={band.x + 16}
            y={ACTUAL_CANVAS_PADDING + 16}
            className={styles.actualBandLabel}
            data-band={band.kind}
            data-band-domain={band.domain}
          >
            {t(band.labelKey)}
          </text>
          <line
            x1={band.x + 16}
            x2={band.x + band.width - 16}
            y1={ACTUAL_CANVAS_PADDING + 24}
            y2={ACTUAL_CANVAS_PADDING + 24}
            className={styles.actualBandRule}
          />
          {band.kind === 'support' ? null : band.columns.map((column) => (
            <g key={`${band.kind}-${band.domain ?? 'none'}-${column.group}`}>
              <text
                x={column.x + 16}
                y={ACTUAL_CANVAS_PADDING + ACTUAL_BAND_HEADER_HEIGHT + 16}
                className={styles.actualGroupLabel}
                data-group-label={column.group}
              >
                {t(ACTUAL_GROUP_LABEL_KEYS[column.group])}
              </text>
              <line
                x1={column.x + 16}
                x2={column.x + column.width - 16}
                y1={ACTUAL_CANVAS_PADDING + ACTUAL_BAND_HEADER_HEIGHT + 24}
                y2={ACTUAL_CANVAS_PADDING + ACTUAL_BAND_HEADER_HEIGHT + 24}
                className={styles.actualGroupRule}
              />
            </g>
          ))}
        </g>
      ))}

      <g aria-hidden="true">
        {layout.links.map((link) => {
          const related = selectedResourceId
            && (link.fromResourceId === selectedResourceId || link.toResourceId === selectedResourceId);
          const hovered = link.edgeId === hoveredEdgeId;
          const geometry = edgeGeometry(link);
          return (
            <g
              key={link.edgeId}
              data-edge-id={link.edgeId}
              className={`${styles.actualLinkGroup} ${selectedResourceId && !related ? styles.actualDimmed : ''} ${hovered ? styles.actualLinkHovered : ''}`}
              onMouseEnter={() => onHoverEdge(link.edgeId)}
              onMouseLeave={() => onHoverEdge(undefined)}
            >
              <path d={geometry.path} className={styles.actualLinkHit} />
              <path d={geometry.path} className={styles.actualLink} markerEnd="url(#actual-topology-arrow)" />
            </g>
          );
        })}
      </g>

      {layout.nodes.map((node) => {
        const selected = node.resourceId === selectedResourceId;
        const matched = nodeMatches(node, search);
        const dimmed = (!matched || !isFocused(node)) && !selected;
        const role = nodeRole(node);
        const name = nodeName(node);
        const nodeHealth = health?.get(node.resourceId);
        const healthLabel = nodeHealth ? t(nodeHealthLabelKey(nodeHealth.state)) : '';
        const meta = [
          domainLabel(node.domain) || t('unknown'),
          node.boundary ? t('topology_actual_boundary_label') : '',
          node.proxy ? t('topology_actual_proxy_label') : '',
          node.resourceClass === 'support' ? t('topology_support_resource') : '',
          node.resourceClass === 'unresolved' ? t('topology_unresolved_resource') : '',
          node.resourceClass === 'nf' && node.domainBand === 'unclassified' ? t('topology_domain_unclassified') : '',
          node.resolved && node.lifecycleState && node.lifecycleState !== 'active' ? node.lifecycleState.toUpperCase() : '',
        ]
          .filter(Boolean)
          .join(' / ');
        const healthSuffix = healthLabel ? `, ${t('topology_health_label')}: ${healthLabel}` : '';
        return (
          <g
            key={node.resourceId}
            role="button"
            tabIndex={0}
            data-resource-id={node.resourceId}
            data-resource-class={node.resourceClass}
            data-node-band={node.band}
            data-boundary={node.boundary ? 'true' : undefined}
            data-proxy={node.proxy ? 'true' : undefined}
            data-group={node.group}
            data-health-state={nodeHealth?.state}
            aria-label={`${role}: ${name}, ${meta}${healthSuffix}`}
            aria-pressed={selected}
            className={`${styles.actualNode} ${styles[`actualGroup${node.group[0].toUpperCase()}${node.group.slice(1)}`]} ${node.resourceClass === 'support' ? styles.actualNodeSupport : ''} ${node.boundary ? styles.actualNodeBoundary : ''} ${node.proxy ? styles.actualNodeProxy : ''} ${selected ? styles.actualNodeSelected : ''} ${node.resolved ? '' : styles.actualNodeUnresolved} ${search.trim() && matched && !selected ? styles.actualNodeMatch : ''} ${dimmed ? styles.actualDimmed : ''}`}
            onClick={() => onSelectResource(node.resourceId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectResource(node.resourceId);
              }
            }}
          >
            <title>{`${role}: ${name}${healthSuffix}`}</title>
            <rect x={node.x} y={node.y} width={ACTUAL_NODE_WIDTH} height={ACTUAL_NODE_HEIGHT} rx={8} className={styles.actualNodeRect} />
            <rect x={node.x} y={node.y + 8} width={4} height={ACTUAL_NODE_HEIGHT - 16} rx={2} className={styles.actualNodeBar} />
            <text x={node.x + 14} y={node.y + 21} className={styles.actualNodeRole}>{truncate(role, 14)}</text>
            <text x={node.x + 14} y={node.y + 37} className={styles.actualNodeName}>{truncate(name, 22)}</text>
            <text x={node.x + 14} y={node.y + 51} className={styles.actualNodeMeta}>{truncate(meta, 24)}</text>
            {nodeHealth ? (
              <circle
                cx={node.x + ACTUAL_NODE_WIDTH - 13}
                cy={node.y + 12}
                r={4}
                className={`${styles.actualHealthDot} ${healthDotClass(nodeHealth.state)}`}
              />
            ) : null}
          </g>
        );
      })}

      <g aria-hidden="true" className={styles.actualLabels}>
        {labels.map(({ edgeId, label, labelX, labelY, width, height }) => (
          <g key={edgeId} data-edge-label={edgeId}>
            <rect
              x={labelX - width / 2}
              y={labelY - height / 2}
              width={width}
              height={height}
              rx={3}
              className={styles.actualLinkLabelBackdrop}
            />
            <text x={labelX} y={labelY + 4} textAnchor="middle" className={styles.actualLinkLabel}>{label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

export default ActualTopologyCanvas;
