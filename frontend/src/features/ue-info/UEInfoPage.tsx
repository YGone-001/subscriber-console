import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Globe,
  Mail,
  Phone,
  RefreshCw,
  Search,
  Server,
  Smartphone,
  Users,
  Wifi,
} from 'lucide-react';
import PageHeader from '../../components/ui/PageHeader';
import MetricStrip, { type MetricStripItem, type MetricTone } from '../../components/ui/MetricStrip';
import { EmptyState, LoadingRows } from '../../components/ui/OperationFeedback';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';
import {
  buildUEInfoPath,
  formatBandwidth,
  formatUETimestamp,
  hasUnavailableSource,
  sourceLabelKey,
  ueStateToken,
} from './ue-info-model';
import type { UEInfo, UEInfoResponse, UESource, UESourceState } from './types';
import styles from '../../styles/modules/ue-info.module.css';

const PAGE_LIMIT = 50;
const REFRESH_INTERVAL_MS = 10000;

type DomainFilter = '' | 'EPS' | '5GS';
type StateFilter = '' | 'registered' | 'idle' | 'connected' | 'unknown';

function sourceTone(state: UESourceState): string {
  switch (state) {
    case 'ok':
      return styles.toneOk;
    case 'unavailable':
    case 'invalid_config':
      return styles.toneDanger;
    default:
      return styles.toneMuted;
  }
}

function stateTone(token: string): string {
  switch (token) {
    case 'registered':
      return styles.toneOk;
    case 'idle':
      return styles.toneWarn;
    case 'connected':
      return styles.toneInfo;
    default:
      return styles.toneMuted;
  }
}

function summaryTone(value: number | null): MetricTone {
  return value === null ? 'muted' : 'primary';
}

function stateSummaryTone(value: number | null, tone: MetricTone): MetricTone {
  return value === null ? 'muted' : tone;
}

function SourceChip({ source }: { source: UESource }) {
  const { t } = useI18n();
  const reason = source.reason ? t(`ue_source_reason_${source.reason}`) : '';
  return (
    <span
      className={`${styles.sourceChip} ${sourceTone(source.state)}`}
      role="listitem"
      title={reason || undefined}
    >
      <span className={styles.sourceName}>{t(sourceLabelKey(source.id))}</span>
      <span className={styles.sourceState}>{t(`ue_source_state_${source.state}`)}</span>
      {source.state === 'ok' && source.itemCount > 0 ? (
        <span className={styles.sourceCount}>{source.itemCount}</span>
      ) : null}
    </span>
  );
}

function DetailBody({ ue }: { ue: UEInfo }) {
  const { t } = useI18n();
  return (
    <div className={styles.detail}>
      <dl className={styles.detailGrid}>
        <div><dt>{t('ue_field_supi')}</dt><dd className={styles.mono}>{ue.supi || '—'}</dd></div>
        <div><dt>{t('ue_field_msisdn')}</dt><dd className={styles.mono}>{ue.msisdn || '—'}</dd></div>
        <div><dt>{t('ue_field_sip_uri')}</dt><dd className={styles.mono}>{ue.sipUri || '—'}</dd></div>
        <div><dt>{t('ue_field_domain')}</dt><dd>{ue.domain || '—'}</dd></div>
        <div><dt>{t('ue_field_rat')}</dt><dd>{ue.rat || '—'}</dd></div>
        <div><dt>{t('ue_field_mm_state')}</dt><dd>{ue.mmState || t('ue_state_unreported')}</dd></div>
        <div><dt>{t('ue_field_cm_state')}</dt><dd>{ue.cmState || t('ue_state_unreported')}</dd></div>
        <div><dt>{t('ue_field_pdn_count')}</dt><dd>{ue.pdnCount}</dd></div>
      </dl>

      {ue.enb || ue.location || ue.ambr ? (
        <div className={styles.detailSection}>
          <h4 className={styles.detailTitle}>{t('ue_detail_radio')}</h4>
          <dl className={styles.detailGrid}>
            {ue.enb ? <div><dt>{t('ue_field_enb')}</dt><dd>{ue.enb.enbId} / {ue.enb.cellId}</dd></div> : null}
            {ue.location ? <div><dt>{t('ue_field_plmn')}</dt><dd className={styles.mono}>{ue.location.plmn}</dd></div> : null}
            {ue.location ? <div><dt>{t('ue_field_tac')}</dt><dd>{ue.location.tac}</dd></div> : null}
            {ue.location ? <div><dt>{t('ue_field_seen_at')}</dt><dd>{formatUETimestamp(ue.location.timestamp)}</dd></div> : null}
            {ue.ambr ? <div><dt>{t('ue_field_downlink')}</dt><dd>{formatBandwidth(ue.ambr.downlink)}</dd></div> : null}
            {ue.ambr ? <div><dt>{t('ue_field_uplink')}</dt><dd>{formatBandwidth(ue.ambr.uplink)}</dd></div> : null}
          </dl>
        </div>
      ) : null}

      {ue.pdn && ue.pdn.length > 0 ? (
        <div className={styles.detailSection}>
          <h4 className={styles.detailTitle}>{t('ue_detail_pdn')}</h4>
          <div className={styles.pdnList}>
            {ue.pdn.map((pdn, index) => (
              <div key={`${pdn.apn}-${pdn.ebi}-${index}`} className={styles.pdnItem}>
                <div className={styles.pdnHead}>
                  <span className={styles.pdnApn}><Globe size={14} /> {pdn.apn || '—'}</span>
                  <span className={styles.pdnState}>{pdn.pduState || '—'}</span>
                </div>
                <div className={styles.pdnMeta}>
                  <span>EBI {pdn.ebi}</span>
                  <span>QCI {pdn.qci}</span>
                  {pdn.ipv4 ? <span className={styles.mono}>{pdn.ipv4}</span> : null}
                  {pdn.ipv6 ? <span className={styles.mono}>{pdn.ipv6}</span> : null}
                </div>
                {pdn.qosFlows && pdn.qosFlows.length > 0 ? (
                  <div className={styles.pdnMeta}>
                    {pdn.qosFlows.map((flow) => (
                      <span key={`${flow.ebi}-${flow.qci}`}>EBI {flow.ebi} / QCI {flow.qci}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function UEInfoPage() {
  const { t, formatDateTime } = useI18n();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState<DomainFilter>('');
  const [state, setState] = useState<StateFilter>('');
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const path = useMemo(
    () => buildUEInfoPath({ q: search, domain, state, limit: PAGE_LIMIT, offset }),
    [search, domain, state, offset],
  );
  const { data, error, isLoading, isValidating, mutate } = useRead<UEInfoResponse>(path);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      if (!isValidating) void mutate();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, isValidating, mutate]);

  const summary = data?.summary;
  const total = summary?.total ?? null;
  const unreported = summary?.stateUnreported ?? 0;
  const kpiItems: MetricStripItem[] = [
    {
      key: 'total',
      icon: <Users size={16} />,
      label: t('ue_kpi_total'),
      value: total === null ? '—' : total,
      detail: summary ? t('ue_kpi_total_detail', { count: unreported }) : (isLoading ? t('loading') : t('ue_error_title')),
      tone: summaryTone(total),
    },
    {
      key: 'registered',
      icon: <Smartphone size={16} />,
      label: t('ue_kpi_registered'),
      value: summary?.registered === null || summary?.registered === undefined ? '—' : summary.registered,
      detail: summary?.registered === null ? t('ue_state_unreported') : undefined,
      tone: stateSummaryTone(summary?.registered ?? null, 'success'),
    },
    {
      key: 'idle',
      icon: <Activity size={16} />,
      label: t('ue_kpi_idle'),
      value: summary?.idle === null || summary?.idle === undefined ? '—' : summary.idle,
      detail: summary?.idle === null ? t('ue_state_unreported') : undefined,
      tone: stateSummaryTone(summary?.idle ?? null, 'warning'),
    },
    {
      key: 'connected',
      icon: <Wifi size={16} />,
      label: t('ue_kpi_connected'),
      value: summary?.connected === null || summary?.connected === undefined ? '—' : summary.connected,
      detail: summary?.connected === null ? t('ue_state_unreported') : undefined,
      tone: stateSummaryTone(summary?.connected ?? null, 'primary'),
    },
  ];

  const applySearch = (event: React.FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setExpanded(null);
    setSearch(searchInput.trim());
  };

  const resetToFirstPage = () => {
    setOffset(0);
    setExpanded(null);
  };

  const refresh = () => {
    void mutate();
  };

  const previous = () => {
    setExpanded(null);
    setOffset(Math.max(0, offset - PAGE_LIMIT));
  };
  const next = () => {
    setExpanded(null);
    setOffset(offset + PAGE_LIMIT);
  };

  const showSourceStrip = data && data.sources.length > 0;
  const partial = data ? (!data.complete || hasUnavailableSource(data)) : false;
  const noSources = data && !data.configured;

  return (
    <div className="container animate-fade-in">
      <PageHeader
        eyebrow={t('ue_page_eyebrow')}
        icon={<Smartphone size={24} />}
        title={t('ue_page_title')}
        description={t('ue_page_description')}
        status={data?.generatedAt ? <span className={styles.snapshot}>{t('ue_snapshot_at', { time: formatDateTime(data.generatedAt) })}</span> : undefined}
        actions={(
          <div className={styles.headerActions}>
            <label className={styles.autoRefresh}>
              <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
              {t('ue_auto_refresh', { seconds: REFRESH_INTERVAL_MS / 1000 })}
            </label>
            <button type="button" className={styles.refreshButton} onClick={refresh} disabled={isValidating}>
              <RefreshCw size={15} className={isValidating ? styles.spinning : undefined} /> {t('refresh')}
            </button>
          </div>
        )}
      />

      <MetricStrip variant="cards" columns={4} className={styles.kpiStrip} ariaLabel={t('ue_page_title')} items={kpiItems} />

      {showSourceStrip ? (
        <section className={styles.sourceSection} aria-label={t('ue_sources_title')}>
          <div className={styles.sourceHead}>
            <h2 className={styles.sectionTitle}>{t('ue_sources_title')}</h2>
            <span className={styles.onlineHint}>
              {t('ue_online_hint', { count: summary?.epc5gcOnlineUsers ?? '—' })}
            </span>
          </div>
          <div className={styles.sourceStrip} role="list">
            {data.sources.map((source) => <SourceChip key={source.id} source={source} />)}
          </div>
          <p className={styles.sourceNote}>{t('ue_ims_pending_note')}</p>
        </section>
      ) : null}

      {partial ? <p className={styles.partial} role="status">{t('ue_partial_warning')}</p> : null}
      {error && data ? <p className={styles.partial} role="alert">{t('ue_refresh_failed')}</p> : null}

      <section className={styles.panel} aria-labelledby="ue-list-title">
        <div className={styles.panelHead}>
          <h2 id="ue-list-title" className={styles.sectionTitle}>{t('ue_list_title')}</h2>
          <span className={styles.panelMeta}>{t('ue_result_count', { total: data?.pagination.total ?? 0 })}</span>
        </div>

        <div className={styles.toolbar}>
          <form className={styles.search} role="search" onSubmit={applySearch}>
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={searchInput}
              placeholder={t('ue_search_placeholder')}
              aria-label={t('ue_search_placeholder')}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button type="submit" className={styles.searchButton}>{t('search')}</button>
          </form>
          <label className={styles.filter}>
            <span>{t('ue_filter_domain')}</span>
            <select value={domain} onChange={(event) => { setDomain(event.target.value as DomainFilter); resetToFirstPage(); }}>
              <option value="">{t('ue_filter_all')}</option>
              <option value="EPS">{t('ue_domain_eps')}</option>
              <option value="5GS">{t('ue_domain_5gs')}</option>
            </select>
          </label>
          <label className={styles.filter}>
            <span>{t('ue_filter_state')}</span>
            <select value={state} onChange={(event) => { setState(event.target.value as StateFilter); resetToFirstPage(); }}>
              <option value="">{t('ue_filter_all')}</option>
              <option value="registered">{t('ue_state_registered')}</option>
              <option value="idle">{t('ue_state_idle')}</option>
              <option value="connected">{t('ue_state_connected')}</option>
              <option value="unknown">{t('ue_state_unknown')}</option>
            </select>
          </label>
        </div>

        {isLoading && !data ? (
          <LoadingRows rows={4} />
        ) : error && !data ? (
          <EmptyState icon={<Server size={40} />} title={t('ue_error_title')} description={t('ue_error_body')} />
        ) : noSources ? (
          <EmptyState icon={<Server size={40} />} title={t('ue_not_configured_title')} description={t('ue_not_configured_body')} />
        ) : data && data.items.length === 0 ? (
          <EmptyState icon={<Users size={40} />} title={t('ue_empty_title')} description={t('ue_empty_body')} />
        ) : data ? (
          <>
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.caption}>{t('ue_table_caption')}</caption>
                <thead>
                  <tr>
                    <th scope="col" data-column-priority="essential">{t('ue_field_supi')}</th>
                    <th scope="col" data-column-priority="important">{t('ue_field_msisdn')}</th>
                    <th scope="col" data-column-priority="important">{t('ue_field_domain_rat')}</th>
                    <th scope="col" data-column-priority="essential">{t('ue_field_state')}</th>
                    <th scope="col" data-column-priority="important">{t('ue_field_pdn_count')}</th>
                    <th scope="col" data-column-priority="supplementary">{t('ue_field_sip_uri')}</th>
                    <th scope="col" data-column-priority="essential">{t('ue_field_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((ue) => {
                    const token = ueStateToken(ue);
                    const isOpen = expanded === ue.supi;
                    return (
                      <UEInfoRow
                        key={ue.supi}
                        ue={ue}
                        token={token}
                        isOpen={isOpen}
                        onToggle={() => setExpanded(isOpen ? null : ue.supi)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className={styles.pager}>
              <span className={styles.pagerInfo}>
                {t('ue_page_range', {
                  start: data.pagination.total === 0 ? 0 : offset + 1,
                  end: Math.min(offset + PAGE_LIMIT, data.pagination.total),
                  total: data.pagination.total,
                })}
              </span>
              <div className={styles.pagerActions}>
                <button type="button" onClick={previous} disabled={offset === 0}>{t('previous')}</button>
                <button type="button" onClick={next} disabled={offset + PAGE_LIMIT >= data.pagination.total}>{t('next')}</button>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function UEInfoRow({ ue, token, isOpen, onToggle }: { ue: UEInfo; token: string; isOpen: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <tr data-state={token}>
        <th scope="row" className={styles.supiCell} data-column-priority="essential" data-label={t('ue_field_supi')}>
          <span className={styles.mono}>{ue.supi || '—'}</span>
        </th>
        <td data-column-priority="important" data-label={t('ue_field_msisdn')}>
          {ue.msisdn ? <span className={styles.contact}><Phone size={13} /> {ue.msisdn}</span> : '—'}
        </td>
        <td data-column-priority="important" data-label={t('ue_field_domain_rat')}>
          <span className={styles.domain}>{ue.domain || '—'}</span>
          <span className={styles.rat}>{ue.rat || '—'}</span>
        </td>
        <td data-column-priority="essential" data-label={t('ue_field_state')}>
          <span className={styles.stateCell}>
            <span className={`${styles.badge} ${stateTone(ue.mmState.toLowerCase() === 'registered' ? 'registered' : 'unknown')}`}>
              {ue.mmState || t('ue_state_unreported')}
            </span>
            <span className={`${styles.badge} ${stateTone(ue.cmState.toLowerCase() === 'idle' ? 'idle' : ue.cmState.toLowerCase() === 'connected' ? 'connected' : 'unknown')}`}>
              {ue.cmState || t('ue_state_unreported')}
            </span>
          </span>
        </td>
        <td data-column-priority="important" data-label={t('ue_field_pdn_count')}>{ue.pdnCount}</td>
        <td data-column-priority="supplementary" data-label={t('ue_field_sip_uri')}>
          {ue.sipUri ? <span className={styles.contact}><Mail size={13} /> {ue.sipUri.replace(/^sip:/, '')}</span> : '—'}
        </td>
        <td data-column-priority="essential" data-label={t('ue_field_action')}>
          <button
            type="button"
            className={styles.expandButton}
            aria-expanded={isOpen}
            aria-label={isOpen ? t('ue_collapse') : t('ue_expand')}
            onClick={onToggle}
          >
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </td>
      </tr>
      {isOpen ? (
        <tr className={styles.detailRow}>
          <td colSpan={7}><DetailBody ue={ue} /></td>
        </tr>
      ) : null}
    </>
  );
}
