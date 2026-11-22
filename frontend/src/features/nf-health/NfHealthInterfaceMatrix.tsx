/*
 * NF Health interface matrix.
 *
 * The matrix is its own server projection, not a second rendering of the target
 * list: the columns are the probe families the server publishes, the rows are
 * the matrix page the server returned, and each cell is the evidence the server
 * measured for that family.
 *
 * Two rules keep it honest:
 *   - a family the server did not return a cell for is rendered as
 *     not_configured, which is neutral: an undeclared interface is not a
 *     failure and not a healthy one;
 *   - a successful metrics read never implies PFCP, Diameter, SIP, SBI or NGAP
 *     health, so no row is synthesized and no protocol state is inferred here.
 */
import { Link } from 'react-router-dom';
import { useI18n } from '../../providers/I18nProvider';
import type { InterfaceMatrixRow, LayerState, ProbeFamily } from './nf-health-types';
import {
  formatTimestamp,
  freshnessStateBadge,
  matrixCell,
  stateBadge,
} from './nf-health-badges';
import styles from '../../styles/modules/nf-health.module.css';

export type NfHealthInterfaceMatrixProps = {
  /** Server-published probe families, in server order. */
  columns: ProbeFamily[];
  /** Matrix rows for the current bounded page, in server order. */
  rows: InterfaceMatrixRow[];
  /** Detail link for one target, already carrying the return-to context. */
  detailHref: (targetId: string) => string;
};

export function NfHealthInterfaceMatrix({ columns, rows, detailHref }: NfHealthInterfaceMatrixProps) {
  const { t } = useI18n();
  return (
    <div className={styles.tableScroll}>
      <table className={styles.matrix} data-nf-health-matrix="true">
        <caption className="sr-only">{t('nf_health_matrix_caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('nf_health_col_name')}</th>
            {columns.map((family) => (
              <th key={family} scope="col">
                {t(`nf_health_probe_family_${family}`)}
              </th>
            ))}
            <th scope="col">{t('nf_health_col_overall')}</th>
            <th scope="col">{t('nf_health_evidence_freshness')}</th>
            <th scope="col">{t('nf_health_col_last_measured')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.targetId} data-nf-health-matrix-row={row.targetId}>
              <th scope="row">
                <Link to={detailHref(row.targetId)} className={styles.rowLink}>
                  {row.name}
                </Link>
                <div className={styles.stack}>
                  <span className={styles.chip}>{row.nfType ?? '-'}</span>
                  {row.domain ? <span className={styles.chip}>{row.domain}</span> : null}
                </div>
              </th>
              {columns.map((family) => (
                <td key={family} data-nf-health-cell={`${row.targetId}:${family}`}>
                  {matrixCell(row.cells[family] ?? { state: 'not_configured' as LayerState }, t)}
                </td>
              ))}
              <td>{stateBadge(row.overallState, t)}</td>
              <td>{freshnessStateBadge(row.freshness, t)}</td>
              <td>{formatTimestamp(row.lastMeasuredAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
