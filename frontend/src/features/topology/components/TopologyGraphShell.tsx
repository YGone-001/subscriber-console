/*
 * Shared topology graph workspace.
 *
 * One structure for every graph source: identity and evidence in the header, a
 * controlled toolbar, the canvas as the primary surface, a contextual inspector
 * on the right, and one status bar. Views keep their own data reads and detail
 * content; this shell only owns layout and the evidence vocabulary.
 *
 * The inspector is rendered only when a selection exists, so closing it returns
 * the full width to the canvas without a separate empty state.
 */
import type { ReactNode } from 'react';
import { useI18n } from '../../../providers/I18nProvider';
import { TopologyInspector } from './TopologyInspector';
import styles from '../../../styles/modules/topology.module.css';

export type TopologyGraphCompleteness = 'complete' | 'partial' | 'unavailable';

export type TopologyGraphShellProps = {
  titleId: string;
  title: string;
  subtitle?: string;
  /* Evidence badge: what this graph is allowed to claim. */
  evidence?: ReactNode;
  /* Read completeness, independent of the evidence source. */
  completeness?: TopologyGraphCompleteness;
  /* Status summary: counts, filters or other facts about the loaded graph. */
  summary?: ReactNode;
  /* Configuration warnings, partial-read notices or source disclosures. */
  notice?: ReactNode;
  /* TopologyGraphToolbar or a page-specific toolbar. */
  toolbar?: ReactNode;
  /* Node or relationship detail content; renders inside TopologyInspector. */
  inspector?: ReactNode;
  inspectorLabel?: string;
  onCloseInspector?: () => void;
  /* Bottom bar: legend on the left, status facts on the right. */
  legend?: ReactNode;
  status?: ReactNode;
  /* Equivalent list / table below the workspace. */
  footer?: ReactNode;
  busy?: boolean;
  children: ReactNode;
};

export function TopologyGraphShell({
  titleId,
  title,
  subtitle,
  evidence,
  completeness,
  summary,
  notice,
  toolbar,
  inspector,
  inspectorLabel,
  onCloseInspector,
  legend,
  status,
  footer,
  busy = false,
  children,
}: TopologyGraphShellProps) {
  const { t } = useI18n();
  return (
    <section
      className={styles.shell}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      data-topology-shell="true"
    >
      {/*
        * Identity, status facts and graph controls share one wrapping row. The
        * canvas is the primary surface, so every stacked row above it is height
        * taken away from the graph; a view that has no subtitle no longer spends
        * a row on its own title either, because the source tab and the page-level
        * data notes already state what the graph is allowed to claim.
       */}
      <div className={styles.shellControls}>
        <div className={styles.shellIdentity}>
          <h2 id={titleId} className={styles.shellTitle}>{title}</h2>
          {evidence ? <span className={styles.shellEvidence} data-graph-evidence="true">{evidence}</span> : null}
          {completeness ? (
            <span
              className={styles.shellCompleteness}
              data-completeness={completeness}
            >
              {t(`ops_completeness_${completeness}`)}
            </span>
          ) : null}
        </div>
        {summary ? <div className={styles.shellSummary} role="status">{summary}</div> : null}
        {toolbar ? <div className={styles.shellToolbar}>{toolbar}</div> : null}
      </div>
      {subtitle ? <p className={styles.shellSubtitle}>{subtitle}</p> : null}
      {notice ? <div className={styles.shellNotice}>{notice}</div> : null}

      <div className={styles.shellBody} data-inspector-open={inspector ? 'true' : undefined}>
        <div className={styles.shellCanvas}>{children}</div>
        {inspector ? (
          <TopologyInspector
            label={inspectorLabel ?? t('topology_inspector_label')}
            onClose={onCloseInspector}
          >
            {inspector}
          </TopologyInspector>
        ) : null}
      </div>

      {legend || status ? (
        <div className={styles.shellStatus} role="status">
          <div className={styles.shellLegend}>{legend}</div>
          <div className={styles.shellStatusMeta}>{status}</div>
        </div>
      ) : null}

      {footer ? <div className={styles.shellFooter}>{footer}</div> : null}
    </section>
  );
}

export default TopologyGraphShell;
