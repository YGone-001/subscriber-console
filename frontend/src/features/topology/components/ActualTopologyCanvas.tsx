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
  ACTUAL_GROUP_LABEL_KEYS,
  ACTUAL_NODE_HEIGHT,
  ACTUAL_NODE_WIDTH,
  nodeMatches,
  type ActualTopologyLayout,
  type ActualTopologyNode,
} from '../actual-topology-model';
import { edgeGeometry, placeEdgeLabels, resolveLabelVisibility } from '../actual-topology-labels';
import { nodeHealthLabelKey, type NodeHealth, type NodeHealthState } from '../actual-topology-health';
import { nfRoleLabel } from '../nf-classification';
import { edgeInterfaceNames, formatInterfaceNames } from '../interface-catalog';
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

function runtimeDotClass(status: string | undefined): string {
  switch (status) {
    case 'running': return styles.actualRuntimeRunning;
    case 'stopped': return styles.actualRuntimeStopped;
    case 'not_detected': return styles.actualRuntimeNotDetected;
    case 'unverified':
    case 'permission_denied':
    case 'unknown':
    case 'stale': return styles.actualRuntimeWarning;
    default: return styles.actualRuntimeUnknown;
  }
}

export function ActualTopologyCanvas({
  layout,
  selectedResourceId,
  focusedResourceId,
  hoveredResourceId,
  search,
  hoveredEdgeId,
  health,
  zoom = 1,
  showAllInterfaceNames = false,
  onSelectResource,
  onFocusResource,
  onHoverResource,
  onHoverEdge,
  onFocusDomain,
}: {
  layout: ActualTopologyLayout;
  selectedResourceId?: string;
  focusedResourceId?: string;
  hoveredResourceId?: string;
  search: string;
  hoveredEdgeId?: string;
  health?: ReadonlyMap<string, NodeHealth>;
  zoom?: number;
  showAllInterfaceNames?: boolean;
  onSelectResource: (resourceId: string) => void;
  onFocusResource?: (resourceId?: string) => void;
  onHoverResource?: (resourceId?: string) => void;
  onHoverEdge: (edgeId?: string) => void;
  /* Focus a domain lane into the single-domain view. Omitted when the owning
   * view has no domain control. */
  onFocusDomain?: (domain: string) => void;
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
  const visibility = useMemo(
    () => resolveLabelVisibility(layout.links, {
      selectedResourceId,
      focusedResourceId,
      hoveredResourceId,
      hoveredEdgeId,
      showAllInterfaceNames,
      zoom,
    }),
    [layout.links, selectedResourceId, focusedResourceId, hoveredResourceId, hoveredEdgeId, showAllInterfaceNames, zoom],
  );
  const labels = useMemo(() => {
    const relatedLinks = layout.links.filter((link) => visibility.visibleEdgeIds.has(link.edgeId));
    const text = new Map<string, string>();
    for (const link of relatedLinks) {
      const interfaceNames = edgeInterfaceNames(link);
      if (interfaceNames.length > 0) {
        text.set(link.edgeId, formatInterfaceNames(interfaceNames));
        continue;
      }
      if (link.protocol) {
        text.set(link.edgeId, link.protocol);
        continue;
      }
      const presentation = RELATIONSHIP_PRESENTATION[link.relationshipType];
      text.set(link.edgeId, presentation ? t(presentation.labelKey) : link.relationshipType);
    }
    return placeEdgeLabels(relatedLinks, text, layout.nodes, layout.width, layout.height);
  }, [layout.links, layout.nodes, layout.width, layout.height, visibility, t]);

  return (
    <svg
      className={styles.actualCanvas}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="group"
      aria-label={t('topology_title')}
      preserveAspectRatio="xMidYMid meet"
      data-actual-canvas="true"
      data-visible-label-count={visibility.visibleEdgeIds.size}
      data-hidden-label-count={visibility.hiddenCount}
    >
      <title>{t('topology_title')}</title>
      <defs>
        <marker id="actual-topology-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" className={styles.actualArrow} />
        </marker>
      </defs>

      {layout.bands.map((band) => {
        const bandKey = `${band.kind}-${band.domain ?? 'none'}`;
        const laneLabel = `${t(band.labelKey)} · ${t('topology_lane_count', { count: band.nodeCount })}${
          band.abnormalCount > 0
            ? ` · ${t('topology_lane_abnormal', { count: band.abnormalCount })}`
            : ''
        }`;
        const focusable = Boolean(band.domain) && Boolean(onFocusDomain);
        const focusDomain = () => {
          if (band.domain) onFocusDomain?.(band.domain);
        };
        return (
          <g key={bandKey}>
            <rect
              x={band.x}
              y={band.y}
              width={band.width}
              height={band.height}
              rx={8}
              className={styles.actualLane}
              aria-hidden="true"
            />
            {focusable ? (
              <g
                role="button"
                tabIndex={0}
                data-lane-focus={band.domain}
                aria-label={t('topology_lane_focus', { domain: t(band.labelKey) })}
                className={styles.actualLaneFocus}
                onClick={focusDomain}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    focusDomain();
                  }
                }}
              >
                <rect
                  x={band.x}
                  y={band.y}
                  width={Math.min(band.width, 260)}
                  height={ACTUAL_BAND_HEADER_HEIGHT}
                  fill="transparent"
                />
                <text
                  x={band.x + 16}
                  y={band.y + 20}
                  className={styles.actualBandLabel}
                  data-band={band.kind}
                  data-band-domain={band.domain}
                >
                  {laneLabel}
                </text>
              </g>
            ) : (
              <text
                x={band.x + 16}
                y={band.y + 20}
                className={styles.actualBandLabel}
                data-band={band.kind}
                data-band-domain={band.domain}
                aria-hidden="true"
              >
                {laneLabel}
              </text>
            )}
            <line
              x1={band.x + 16}
              x2={band.x + band.width - 16}
              y1={band.y + 24}
              y2={band.y + 24}
              className={styles.actualBandRule}
              aria-hidden="true"
            />
            {band.kind === 'support' ? null : band.columns.map((column) => (
              <g key={`${bandKey}-${column.group}`} aria-hidden="true">
                <text
                  x={column.x + 16}
                  y={band.y + ACTUAL_BAND_HEADER_HEIGHT + 16}
                  className={styles.actualGroupLabel}
                  data-group-label={column.group}
                >
                  {t(ACTUAL_GROUP_LABEL_KEYS[column.group])}
                </text>
                <line
                  x1={column.x + 16}
                  x2={column.x + column.width - 16}
                  y1={band.y + ACTUAL_BAND_HEADER_HEIGHT + 24}
                  y2={band.y + ACTUAL_BAND_HEADER_HEIGHT + 24}
                  className={styles.actualGroupRule}
                />
              </g>
            ))}
          </g>
        );
      })}

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
              data-evidence={link.source?.kind}
              data-link-related={related ? 'true' : undefined}
              className={`${styles.actualLinkGroup} ${link.source?.kind === 'configured' ? styles.actualLinkConfigured : ''} ${related ? styles.actualLinkRelated : ''} ${selectedResourceId && !related ? styles.actualDimmed : ''} ${hovered ? styles.actualLinkHovered : ''}`}
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
        /* A runtime node is often named exactly like its role (AMF / AMF).
         * The name is the primary identity, so an identical role eyebrow is
         * dropped instead of repeating the same word twice. */
        const duplicateRole = Boolean(role) && role.trim().toLowerCase() === name.trim().toLowerCase();
        const showRole = Boolean(role) && !duplicateRole;
        const nameY = showRole ? node.y + 37 : node.y + 31;
        const metaY = showRole ? node.y + 51 : node.y + 47;
        const identity = showRole ? `${role}: ${name}` : name;
        const nodeHealth = health?.get(node.resourceId);
        const healthLabel = nodeHealth ? t(nodeHealthLabelKey(nodeHealth.state)) : '';
        const runtimeKey = node.runtimeStatus ? `runtime_status_${node.runtimeStatus}` : '';
        const runtimeTranslation = runtimeKey ? t(runtimeKey) : '';
        const runtimeLabel = runtimeTranslation && runtimeTranslation !== runtimeKey
          ? runtimeTranslation
          : (node.runtimeStatus || '');
        const meta = [
          domainLabel(node.domain) || t('unknown'),
          node.boundary ? t('topology_actual_boundary_label') : '',
          node.proxy ? t('topology_actual_proxy_label') : '',
          node.resourceClass === 'support' ? t('topology_support_resource') : '',
          node.resourceClass === 'unresolved' ? t('topology_unresolved_resource') : '',
          node.resourceClass === 'nf' && node.domainBand === 'unclassified' ? t('topology_domain_unclassified') : '',
          runtimeLabel ? `${t('topology_runtime_label')}: ${runtimeLabel}` : '',
          node.resolved && node.lifecycleState
            && node.lifecycleState !== 'active'
            && node.lifecycleState !== 'unknown'
            ? node.lifecycleState.toUpperCase() : '',
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
            data-role-deduped={duplicateRole ? 'true' : undefined}
            data-runtime-status={node.runtimeStatus}
            data-health-state={nodeHealth?.state}
            aria-label={`${identity}, ${meta}${healthSuffix}`}
            aria-pressed={selected}
            className={`${styles.actualNode} ${styles[`actualGroup${node.group[0].toUpperCase()}${node.group.slice(1)}`]} ${node.resourceClass === 'support' ? styles.actualNodeSupport : ''} ${node.boundary ? styles.actualNodeBoundary : ''} ${node.proxy ? styles.actualNodeProxy : ''} ${node.runtimeStatus === 'stopped' ? styles.actualNodeStopped : ''} ${node.runtimeStatus === 'not_detected' ? styles.actualNodeNotDetected : ''} ${selected ? styles.actualNodeSelected : ''} ${node.resolved ? '' : styles.actualNodeUnresolved} ${search.trim() && matched && !selected ? styles.actualNodeMatch : ''} ${dimmed ? styles.actualDimmed : ''}`}
            onClick={() => onSelectResource(node.resourceId)}
            onFocus={() => onFocusResource?.(node.resourceId)}
            onBlur={() => onFocusResource?.(undefined)}
            onMouseEnter={() => onHoverResource?.(node.resourceId)}
            onMouseLeave={() => onHoverResource?.(undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectResource(node.resourceId);
              }
            }}
          >
            <title>{`${identity}${healthSuffix}`}</title>
            <rect x={node.x} y={node.y} width={ACTUAL_NODE_WIDTH} height={ACTUAL_NODE_HEIGHT} rx={8} className={styles.actualNodeRect} />
            <rect x={node.x} y={node.y + 8} width={4} height={ACTUAL_NODE_HEIGHT - 16} rx={2} className={styles.actualNodeBar} />
            {showRole ? (
              <text x={node.x + 14} y={node.y + 21} className={styles.actualNodeRole}>{truncate(role, 14)}</text>
            ) : null}
            <text x={node.x + 14} y={nameY} className={styles.actualNodeName}>{truncate(name, 22)}</text>
            <text x={node.x + 14} y={metaY} className={styles.actualNodeMeta}>{truncate(meta, 24)}</text>
            {nodeHealth ? (
              <circle
                cx={node.x + ACTUAL_NODE_WIDTH - 13}
                cy={node.y + 12}
                r={4}
                className={`${styles.actualHealthDot} ${healthDotClass(nodeHealth.state)}`}
              />
            ) : node.runtimeStatus ? (
              <circle
                cx={node.x + ACTUAL_NODE_WIDTH - 13}
                cy={node.y + 12}
                r={4}
                className={`${styles.actualRuntimeDot} ${runtimeDotClass(node.runtimeStatus)}`}
              />
            ) : null}
          </g>
        );
      })}

      <g aria-hidden="true" className={styles.actualLabels}>
        {labels.map(({ edgeId, label, labelX, labelY, width, height }) => {
          const link = layout.links.find((candidate) => candidate.edgeId === edgeId);
          const kind = link && edgeInterfaceNames(link).length > 0 ? 'interface' : 'relationship';
          return (
            <g key={edgeId} data-edge-label={edgeId} data-label-kind={kind}>
              <rect
                x={labelX - width / 2}
                y={labelY - height / 2}
                width={width}
                height={height}
                rx={3}
                className={styles.actualLinkLabelBackdrop}
              />
              <text
                x={labelX}
                y={labelY + 4}
                textAnchor="middle"
                className={`${styles.actualLinkLabel} ${kind === 'interface' ? styles.actualLinkLabelInterface : styles.actualLinkLabelRelationship}`}
              >
                {label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export default ActualTopologyCanvas;
