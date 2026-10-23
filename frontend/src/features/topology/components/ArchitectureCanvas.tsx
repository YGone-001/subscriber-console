/*
 * 3GPP reference architecture canvas.
 *
 * A deterministic SVG rendering of the static reference skeleton with the
 * projected Inventory binding and NF Health state overlaid. It is deliberately
 * not a graph layout engine: the coordinates come from the reference data, so
 * the same deployment always renders the same picture and the canvas can be
 * verified by counting nodes and links.
 *
 * The canvas is never the only representation: the detail panel beside it
 * carries the same facts as text, and every node is keyboard reachable.
 */
import { useMemo } from 'react';
import { useI18n } from '../../../providers/I18nProvider';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
} from '../reference-architecture';
import {
  domainLabelKey,
  stateLabelKey,
  type ArchitectureLinkEvidence,
  type ArchitectureLinkView,
  type ArchitectureNodeView,
  type NodeTone,
} from '../architecture-model';
import {
  buildArchitectureBusLayout,
  center,
  clipToNode,
  placeLinkLabel,
  type ArchitectureExpandedLink,
} from '../architecture-link-layout';
import styles from '../../../styles/modules/architecture.module.css';

export { placeLinkLabel } from '../architecture-link-layout';

const TONE_CLASS: Record<NodeTone, string> = {
  unregistered: styles.toneUnregistered,
  observed: styles.toneObserved,
  ambiguous: styles.toneAmbiguous,
  unmonitored: styles.toneUnmonitored,
  unresolved: styles.toneUnresolved,
  healthy: styles.toneHealthy,
  degraded: styles.toneDegraded,
  unhealthy: styles.toneUnhealthy,
  stale: styles.toneStale,
  unknown: styles.toneUnknown,
};

const DOMAIN_CLASS: Record<string, string> = {
  cp: styles.domainCp,
  sp: styles.domainSp,
  up: styles.domainUp,
  dm: styles.domainDm,
  legacy: styles.domainLegacy,
};

const LINK_EVIDENCE_CLASS: Record<ArchitectureLinkEvidence, string> = {
  declared: styles.linkDeclared,
  bound: styles.linkBound,
  observed: styles.linkObserved,
  unresolved: styles.linkUnresolved,
  reference: styles.linkReference,
};

function ExpandedBusLink({ link }: { link: ArchitectureExpandedLink }) {
  const width = link.label.length * 5.6 + 8;
  return (
    <g key={link.key} data-sbi-expanded={link.key} data-evidence={link.evidence}>
      <path d={link.path} className={LINK_EVIDENCE_CLASS[link.evidence]} />
      <rect
        x={link.labelX - width / 2}
        y={link.labelY - 9}
        width={width}
        height={13}
        rx={3}
        className={styles.linkLabelBackdrop}
      />
      <text x={link.labelX} y={link.labelY} textAnchor="middle" className={styles.linkLabel}>
        {link.label}
      </text>
    </g>
  );
}

export function ArchitectureCanvas({
  nodes,
  links,
  selectedRole,
  onSelect,
}: {
  nodes: ArchitectureNodeView[];
  links: ArchitectureLinkView[];
  selectedRole?: string;
  onSelect?: (role: string) => void;
}) {
  const { t } = useI18n();
  const byRole = new Map(nodes.map((node) => [node.role, node]));
  const busLayout = useMemo(
    () => buildArchitectureBusLayout(nodes, links, selectedRole),
    [nodes, links, selectedRole],
  );
  const busKeys = new Set(busLayout.aggregatedKeys);
  const pointLinks = links.filter((link) => !busKeys.has(link.key));

  return (
    <svg
      className={styles.canvas}
      viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
      role="img"
      aria-label={t('arch_canvas_aria')}
      preserveAspectRatio="xMidYMid meet"
      data-architecture-svg="true"
    >
      <title>{t('arch_canvas_aria')}</title>
      <desc>{t('arch_canvas_desc')}</desc>

      <g aria-hidden="true">
        <g className={styles.sbiBus} data-sbi-bus={busLayout.aggregatedLinkCount}>
          {busLayout.trunkSegments.map((segment) => (
            <path key={segment.key} d={segment.path} className={styles.sbiTrunk} data-sbi-trunk={segment.key} />
          ))}
          {busLayout.stubs.map((stub) => (
            <path
              key={stub.role}
              d={stub.path}
              className={styles.sbiStub}
              data-sbi-stub={stub.role}
              data-evidence={stub.evidence}
            />
          ))}
          {busLayout.aggregatedLinkCount > 0 ? (
            <text
              x={busLayout.label.x}
              y={busLayout.label.y}
              textAnchor="end"
              className={styles.sbiLabel}
              data-sbi-label="true"
            >
              {busLayout.label.text} · {busLayout.label.count}
            </text>
          ) : null}
        </g>

        {pointLinks.map((link) => {
          const source = byRole.get(link.source);
          const target = byRole.get(link.target);
          if (!source || !target) return null;
          const from = clipToNode(center(source), center(target));
          const to = clipToNode(center(target), center(source));
          const anchor = placeLinkLabel(from, to, nodes);
          const labelX = anchor.x;
          const labelY = anchor.y - 5;
          const width = link.interfaceLabel.length * 5.6 + 8;
          return (
            <g key={link.key} data-link-key={link.key} data-evidence={link.evidence}>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={LINK_EVIDENCE_CLASS[link.evidence]}
              />
              <rect
                x={labelX - width / 2}
                y={labelY - 9}
                width={width}
                height={13}
                rx={3}
                className={styles.linkLabelBackdrop}
              />
              <text x={labelX} y={labelY} textAnchor="middle" className={styles.linkLabel}>
                {link.interfaceLabel}
              </text>
            </g>
          );
        })}

        {busLayout.expanded.map((link) => (
          <ExpandedBusLink key={link.key} link={link} />
        ))}
      </g>

      {nodes.map((node) => {
        const selected = node.role === selectedRole;
        const stateText = t(stateLabelKey(node.tone));
        const ariaLabel = `${node.label} ${t(domainLabelKey(node.domain))}: ${stateText}`;
        const activate = () => onSelect?.(node.role);
        return (
          <g
            key={node.role}
            role="button"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-pressed={selected}
            data-binding={node.binding}
            data-role={node.role}
            className={`${styles.node} ${TONE_CLASS[node.tone]} ${DOMAIN_CLASS[node.domain]} ${selected ? styles.nodeSelected : ''}`}
            onClick={activate}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }}
          >
            <rect
              x={node.x}
              y={node.y}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={10}
              className={styles.nodeRect}
            />
            <rect
              x={node.x}
              y={node.y + 8}
              width={3.5}
              height={NODE_HEIGHT - 16}
              rx={1.75}
              className={styles.nodeBar}
            />
            <text x={node.x + 14} y={node.y + 23} className={styles.nodeLabel}>
              {node.label}
            </text>
            <text x={node.x + 14} y={node.y + 41} className={styles.nodeState}>
              {stateText}
            </text>
            <circle cx={node.x + NODE_WIDTH - 14} cy={node.y + 16} r={4} className={styles.nodeDot} />
          </g>
        );
      })}
    </svg>
  );
}

export default ArchitectureCanvas;
