/*
 * Advisory reconciliation panel.
 *
 * The live projection already compares the configured evidence with the
 * persisted ledger. This panel is the operator entry to that comparison: it
 * lists the differences, grades each interface on its own and lets the reader
 * locate the pair on the canvas. It never writes either side and never calls a
 * difference an error: a declaration without evidence may simply describe a
 * link this manifest does not cover.
 *
 * Completeness is part of the message. A truncated ledger read is stated as a
 * lower bound, so an empty list can never be read as "the topology is clean".
 */
import { useI18n } from '../../../providers/I18nProvider';
import type {
  ReconciliationGroups,
  ReconciliationRow,
  ReconciliationSummary,
} from '../live-topology-model';
import styles from '../../../styles/modules/architecture.module.css';

export type TopologyReconciliationPanelProps = {
  summary: ReconciliationSummary;
  groups: ReconciliationGroups;
  /* Selects a component on the canvas so a difference can be inspected in place. */
  onLocate?: (componentId: string) => void;
  /* The declared canvas selects Inventory resources, not runtime components. */
  onLocateResource?: (resourceId: string) => void;
};

function verdictKey(verdict: string): string {
  return `topology_recon_verdict_${verdict || 'unannotated'}`;
}

function interfaceKey(status: string): string {
  return `topology_recon_interface_${status || 'declaration_only'}`;
}

function ReconciliationRowItem({
  row,
  onLocate,
  onLocateResource,
}: {
  row: ReconciliationRow;
  onLocate?: (componentId: string) => void;
  onLocateResource?: (resourceId: string) => void;
}) {
  const { t } = useI18n();
  const label = `${row.fromComponentId || '-'} → ${row.toComponentId || '-'}`;
  const locate = onLocateResource && row.fromResourceId
    ? () => onLocateResource(row.fromResourceId)
    : onLocate && row.fromComponentId
      ? () => onLocate(row.fromComponentId)
      : undefined;
  return (
    <li className={styles.reconRow} data-recon-row={row.key}>
      <div className={styles.reconPath}>
        <strong>{label}</strong>
        {row.relationshipType ? <span className={styles.reconMeta}>{row.relationshipType}</span> : null}
        {row.verdict ? (
          <span className={styles.reconBadge} data-recon-verdict={row.verdict}>
            {t(verdictKey(row.verdict))}
          </span>
        ) : null}
        {row.retired ? (
          <span className={styles.reconBadge} data-recon-retired="true">
            {t('topology_recon_retired')}
          </span>
        ) : null}
      </div>
      {row.interfaces.length > 0 ? (
        <ul className={styles.reconInterfaces}>
          {row.interfaces.map((entry) => (
            <li
              key={`${row.key}-${entry.name}-${entry.status}`}
              data-interface-status={entry.status}
            >
              <span className={styles.reconInterfaceName}>{entry.name}</span>
              <span>{t(interfaceKey(entry.status))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.reconMeta} data-recon-no-interfaces="true">
          {t('topology_recon_no_interfaces')}
        </p>
      )}
      {row.claims > 0 ? (
        <p className={styles.reconMeta} data-recon-claims={row.claims}>
          {t('topology_recon_claims', { count: row.claims })}
        </p>
      ) : null}
      {locate ? (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={locate}
          aria-label={`${t('topology_recon_locate')}: ${label}`}
        >
          {t('topology_recon_locate')}
        </button>
      ) : null}
    </li>
  );
}

export function TopologyReconciliationPanel({
  summary,
  groups,
  onLocate,
  onLocateResource,
}: TopologyReconciliationPanelProps) {
  const { t } = useI18n();
  const sections: ReadonlyArray<readonly [string, string, ReconciliationRow[]]> = [
    ['undeclared', 'topology_recon_group_undeclared', groups.undeclared],
    ['unevidenced', 'topology_recon_group_unevidenced', groups.unevidenced],
    ['disagreed', 'topology_recon_group_disagreed', groups.disagreed],
  ];
  const differences = sections.reduce((total, [, , rows]) => total + rows.length, 0);

  return (
    <details
      className={styles.liveUnresolved}
      data-reconciliation="true"
      data-recon-complete={summary.complete ? 'true' : 'false'}
      open={differences > 0}
    >
      <summary>{t('topology_recon_title')}</summary>
      <div className={styles.liveChips}>
        <span className={styles.liveChip} data-recon-count="agreed">
          {t('topology_recon_agreed', { count: groups.agreed })}
        </span>
        <span className={styles.liveChip} data-recon-count="undeclared">
          {t('topology_recon_undeclared', { count: groups.undeclared.length })}
        </span>
        <span className={styles.liveChip} data-recon-count="unevidenced">
          {t('topology_recon_unevidenced', { count: groups.unevidenced.length })}
        </span>
        <span className={styles.liveChip} data-recon-count="disagreed">
          {t('topology_recon_disagreed', { count: groups.disagreed.length })}
        </span>
        {summary.rulesVersion ? (
          <span className={styles.liveChip} data-recon-rules={summary.rulesVersion}>
            {t('topology_recon_rules', { version: summary.rulesVersion })}
          </span>
        ) : null}
      </div>
      <p
        className={styles.reconMeta}
        data-recon-completeness={summary.complete ? 'complete' : 'partial'}
      >
        {summary.complete ? t('topology_recon_complete') : t('topology_recon_truncated')}
      </p>
      {differences === 0 ? (
        <p className={styles.reconMeta} data-recon-clean="true">
          {t('topology_recon_clean')}
        </p>
      ) : null}
      {sections.map(([key, titleKey, rows]) => (
        rows.length === 0 ? null : (
          <section key={key} className={styles.reconGroup} data-recon-group={key}>
            <h3 className={styles.reconGroupTitle}>{t(titleKey)}</h3>
            <ul className={styles.reconList}>
              {rows.map((row) => (
                <ReconciliationRowItem
                  key={row.key}
                  row={row}
                  onLocate={onLocate}
                  onLocateResource={onLocateResource}
                />
              ))}
            </ul>
          </section>
        )
      ))}
    </details>
  );
}