import { useMemo, useState } from 'react';
import { BarChart, Bar, LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, RefreshCw } from 'lucide-react';
import { getBlob } from '../../lib/api/read-client';
import { useRead } from '../../lib/api/use-read';
import { useI18n } from '../../providers/I18nProvider';

type UnknownRecord = Record<string, unknown>;
type PlmnRecord = { mcc?: string; mnc?: string; country?: string; network?: string };
const asRecord = (value: unknown): UnknownRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
const listOf = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.map(asRecord) : [];
const rowsOf = (value: unknown): UnknownRecord[] => { const record = asRecord(value); return listOf(record.records ?? record.items ?? record.users ?? record.profiles ?? record.plans ?? record.subscribers ?? record.data ?? value); };
const text = (value: unknown) => value === undefined || value === null || value === '' ? '—' : String(value);
const numberValue = (value: unknown) => typeof value === 'number' ? value : Number(value ?? 0) || 0;
function resolvePlmn(row: UnknownRecord, catalog: PlmnRecord[]): string {
  const explicit = typeof row.plmn === 'string' ? row.plmn : undefined;
  if (explicit) return explicit;
  const imsi = text(row.imsi); const mcc = text(row.mcc ?? imsi.slice(0, 3)); const mnc = text(row.mnc ?? imsi.slice(3, 5));
  const match = catalog.find((entry) => entry.mcc === mcc && entry.mnc === mnc);
  return match ? `${match.country ?? mcc} / ${match.network ?? mnc}` : `${mcc}-${mnc}`;
}

function ReadState({ loading, error, empty, onRefresh, children }: { loading: boolean; error?: Error; empty: boolean; onRefresh: () => void; children: React.ReactNode }) {
  const { t } = useI18n();
  if (loading) return <section className="read-state" role="status">{t('loading')}</section>;
  if (error) return <section className="read-state error" role="alert"><p>{error.message}</p><button type="button" onClick={onRefresh}>{t('refresh')}</button></section>;
  if (empty) return <section className="read-state">{t('empty')}</section>;
  return <>{children}</>;
}

function PageHeader({ title, refresh }: { title: string; refresh?: () => void }) {
  const { t } = useI18n();
  return <header className="read-page-header"><div><p className="read-marker">{t('read_only_parity')}</p><h1>{title}</h1></div>{refresh ? <button type="button" className="read-refresh" onClick={refresh}><RefreshCw size={16} />{t('refresh')}</button> : null}</header>;
}

function SimpleTable({ rows, columns, detailPath }: { rows: UnknownRecord[]; columns: Array<[string, string]>; detailPath?: (row: UnknownRecord) => string }) {
  const { t } = useI18n();
  return <div className="read-table-wrap"><table className="read-table"><caption className="sr-only">{t('read_table')}</caption><thead><tr>{columns.map(([key, label]) => <th key={key}>{label}</th>)}{detailPath ? <th>{t('details')}</th> : null}</tr></thead><tbody>{rows.map((row, index) => <tr key={text(row.id ?? row.imsi ?? row.plan_id ?? row.name ?? row.username ?? index)}>{columns.map(([key, label]) => <td data-label={label} key={key}>{text(row[key])}</td>)}{detailPath ? <td><Link to={detailPath(row)}>{t('details')}</Link></td> : null}</tr>)}</tbody></table></div>;
}

function ListPage({ title, path, columns, detailPath, search = false }: { title: string; path: (query: string, page: number) => string; columns: Array<[string, string]>; detailPath?: (row: UnknownRecord) => string; search?: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1);
  const data = useRead<unknown>(path(query, page)); const rows = rowsOf(data.data); const total = numberValue(asRecord(data.data).total ?? asRecord(asRecord(data.data).pagination).total ?? rows.length);
  return <section className="read-page"><PageHeader title={title} refresh={() => void data.mutate()} />{search ? <label className="read-search">{t('search')}<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label> : null}<ReadState loading={data.isLoading} error={data.error} empty={!rows.length} onRefresh={() => void data.mutate()}><p className="read-summary">{total} {t('records')}</p><SimpleTable rows={rows} columns={columns} detailPath={detailPath} /><nav className="read-pagination"><button type="button" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>{t('previous')}</button><span>{page}</span><button type="button" disabled={rows.length === 0} onClick={() => setPage((value) => value + 1)}>{t('next')}</button></nav></ReadState></section>;
}

function DetailPage({ title, path, sections, exportPath }: { title: string; path: string | null; sections?: string[]; exportPath?: string | null }) {
  const { t } = useI18n(); const navigate = useNavigate(); const data = useRead<unknown>(path); const record = asRecord(data.data); const entries = Object.entries(record).filter(([key]) => !['rules', 'records', 'items', 'subscribers', 'operations'].includes(key));
  async function download() { if (!exportPath) return; const blob = await getBlob(exportPath); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${title}.json`; link.click(); URL.revokeObjectURL(url); }
  return <section className="read-page"><PageHeader title={title} refresh={() => void data.mutate()} /><button type="button" className="read-back" onClick={() => navigate(-1)}>{t('back')}</button><ReadState loading={data.isLoading} error={data.error} empty={data.data !== undefined && entries.length === 0} onRefresh={() => void data.mutate()}><dl className="read-detail">{entries.map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : text(value)}</dd></div>)}</dl>{sections?.map((section) => <ReadDetailCollection key={section} title={section} value={record[section]} />)}{exportPath ? <button type="button" className="read-refresh" onClick={() => void download()}><Download size={16} />{t('export')}</button> : null}</ReadState></section>;
}

function ReadDetailCollection({ title, value }: { title: string; value: unknown }) { const rows = listOf(value); if (!rows.length) return null; return <section className="read-collection"><h2>{title}</h2><SimpleTable rows={rows} columns={Object.keys(rows[0]).slice(0, 5).map((key) => [key, key])} /></section>; }

export function DashboardPage() {
  const { t } = useI18n(); const metrics = useRead<unknown>('/api/analytics/metrics'); const spark = useRead<unknown>('/api/analytics/sparkline'); const alerts = useRead<unknown>('/api/alerts'); const contracts = useRead<unknown>('/api/ocs/subscribers?limit=1');
  const metric = asRecord(metrics.data); const trend = listOf(asRecord(spark.data).traffic).map((value, index) => ({ index, value: numberValue(value) })); const alertRows = rowsOf(alerts.data); const cards = [['totalTraffic', metric.totalTraffic], ['subscribers', metric.totalSubscribers ?? asRecord(metric.ocsBalances).totalSubscribers], ['alerts', alertRows.length], ['contracts', asRecord(contracts.data).total ?? asRecord(asRecord(contracts.data).pagination).total]];
  const loading = metrics.isLoading || spark.isLoading || alerts.isLoading || contracts.isLoading; const error = metrics.error ?? spark.error ?? alerts.error ?? contracts.error;
  return <section className="read-page"><PageHeader title={t('nav_dashboard')} refresh={() => { void metrics.mutate(); void spark.mutate(); void alerts.mutate(); void contracts.mutate(); }} /><ReadState loading={loading} error={error} empty={!metrics.data} onRefresh={() => void metrics.mutate()}><div className="read-kpis">{cards.map(([key, value]) => <article key={String(key)}><span>{String(key)}</span><strong>{text(value)}</strong></article>)}</div><div className="read-chart"><h2>{t('traffic_trend')}</h2><ResponsiveContainer width="100%" height={220}><LineChart data={trend}><XAxis dataKey="index" /><YAxis /><Tooltip /><Line dataKey="value" stroke="#1468d4" dot={false} /></LineChart></ResponsiveContainer></div><section className="read-workbench"><h2>{t('workbench')}</h2><SimpleTable rows={alertRows} columns={[['level', 'Level'], ['title', 'Title'], ['message', 'Message'], ['is_acknowledged', 'Acknowledged']]} /></section></ReadState></section>;
}

export function SubscribersPage() {
  const { t } = useI18n(); const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const subscribers = useRead<unknown>(`/api/subscribers?detail=true&page=${page}&limit=20&q=${encodeURIComponent(query)}`); const catalog = useRead<PlmnRecord[]>('/data/mcc-mnc-table.json'); const rows = rowsOf(subscribers.data).map((row) => ({ ...row, plmn: resolvePlmn(row, catalog.data ?? []) })); const total = numberValue(asRecord(subscribers.data).total ?? asRecord(asRecord(subscribers.data).pagination).total ?? rows.length);
  return <section className="read-page"><PageHeader title={t('nav_subscribers')} refresh={() => void subscribers.mutate()} /><label className="read-search">{t('search')}<input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label><ReadState loading={subscribers.isLoading || catalog.isLoading} error={subscribers.error ?? catalog.error} empty={!rows.length} onRefresh={() => { void subscribers.mutate(); void catalog.mutate(); }}><p className="read-summary">{total} {t('records')}</p><SimpleTable rows={rows} columns={[['imsi', 'IMSI'], ['status', 'Status'], ['traffic', 'Traffic'], ['profile', 'Profile'], ['plmn', 'PLMN']]} /><nav className="read-pagination"><button type="button" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>{t('previous')}</button><span>{page}</span><button type="button" disabled={!rows.length} onClick={() => setPage((value) => value + 1)}>{t('next')}</button></nav></ReadState></section>;
}
export function BalancesPage() { return <ListPage title="Balances" search path={(query, page) => `/api/ocs/balances?page=${page}&limit=20&imsi=${encodeURIComponent(query)}`} columns={[['imsi', 'IMSI'], ['data_available', 'Data available'], ['voice_available', 'Voice available'], ['sms_available', 'SMS available'], ['status', 'Status'], ['version', 'Version']]} detailPath={(row) => `/ocs/balances/${encodeURIComponent(text(row.imsi))}`} />; }
export function BalanceDetailPage() { const { imsi } = useParams(); return <DetailPage title={`Balance ${imsi ?? ''}`} path={imsi ? `/api/ocs/balances/${encodeURIComponent(imsi)}` : null} />; }
export function ContractsPage() { return <ListPage title="Contracts" search path={(query, page) => `/api/ocs/subscribers?page=${page}&limit=20&imsi=${encodeURIComponent(query)}`} columns={[['imsi', 'IMSI'], ['plan_id', 'Plan'], ['status', 'Status'], ['version', 'Version'], ['updated_at', 'Updated']]} detailPath={(row) => `/ocs/contracts/${encodeURIComponent(text(row.imsi))}`} />; }
export function ContractDetailPage() { const { imsi } = useParams(); return <DetailPage title={`Contract ${imsi ?? ''}`} path={imsi ? `/api/ocs/subscribers?imsi=${encodeURIComponent(imsi)}&limit=1` : null} />; }
export function TariffsPage() { return <ListPage title="Tariff plans" path={(_, page) => `/api/tariff-plans?page=${page}&limit=20`} columns={[['plan_id', 'Plan ID'], ['name', 'Name'], ['status', 'Status'], ['version', 'Version'], ['subscriber_count', 'Subscribers'], ['updated_at', 'Updated']]} detailPath={(row) => `/ocs/tariffs/${encodeURIComponent(text(row.plan_id))}`} />; }
export function TariffDetailPage() {
  const { planId } = useParams(); const encoded = planId ? encodeURIComponent(planId) : null; const { t } = useI18n(); const plan = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}` : null); const rules = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}/rules` : null); const subscribers = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}/subscribers` : null); const operations = useRead<unknown>(encoded ? `/api/tariff-plans/${encoded}/operations` : null); const record = asRecord(plan.data);
  async function download() { if (!encoded) return; const blob = await getBlob(`/api/tariff-plans/${encoded}/export`); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `tariff-plan-${planId}.json`; link.click(); URL.revokeObjectURL(url); }
  return <section className="read-page"><PageHeader title={`Tariff ${planId ?? ''}`} refresh={() => { void plan.mutate(); void rules.mutate(); void subscribers.mutate(); void operations.mutate(); }} /><ReadState loading={plan.isLoading} error={plan.error} empty={plan.data !== undefined && !Object.keys(record).length} onRefresh={() => void plan.mutate()}><dl className="read-detail">{Object.entries(record).filter(([, value]) => typeof value !== 'object').map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{text(value)}</dd></div>)}</dl><ReadDetailCollection title="rules" value={asRecord(rules.data).rules ?? rules.data} /><ReadDetailCollection title="subscribers" value={asRecord(subscribers.data).subscribers ?? subscribers.data} /><ReadDetailCollection title="operations" value={asRecord(operations.data).operations ?? operations.data} /><button type="button" className="read-refresh" onClick={() => void download()}><Download size={16} />{t('export')}</button></ReadState></section>;
}
export function ProfilesPage() {
  const { t } = useI18n(); const [query, setQuery] = useState(''); const [selected, setSelected] = useState<string | null>(null); const profiles = useRead<unknown>('/api/profiles'); const rows = rowsOf(profiles.data).filter((row) => `${text(row.name)} ${text(row.title)}`.toLowerCase().includes(query.toLowerCase())); const detail = useRead<unknown>(selected ? `/api/profiles/${encodeURIComponent(selected)}` : null); const stats = useRead<unknown>(selected ? `/api/profiles/${encodeURIComponent(selected)}/stats` : null); const versions = useRead<unknown>(selected ? `/api/profiles/${encodeURIComponent(selected)}/versions` : null);
  return <section className="read-page"><PageHeader title={t('nav_profile')} refresh={() => void profiles.mutate()} /><label className="read-search">{t('search')}<input value={query} onChange={(event) => setQuery(event.target.value)} /></label><ReadState loading={profiles.isLoading} error={profiles.error} empty={!rows.length} onRefresh={() => void profiles.mutate()}><div className="read-table-wrap"><table className="read-table"><caption className="sr-only">{t('read_table')}</caption><thead><tr><th>Name</th><th>Title</th><th>Details</th></tr></thead><tbody>{rows.map((row) => <tr key={text(row.name)}><td data-label="Name">{text(row.name)}</td><td data-label="Title">{text(row.title)}</td><td data-label={t('details')}><button type="button" className="read-refresh" onClick={() => setSelected(text(row.name))}>{t('details')}</button></td></tr>)}</tbody></table></div></ReadState>{selected ? <section className="read-collection"><h2>{selected}</h2><ReadState loading={detail.isLoading} error={detail.error} empty={false} onRefresh={() => { void detail.mutate(); void stats.mutate(); void versions.mutate(); }}><dl className="read-detail">{Object.entries(asRecord(detail.data)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : text(value)}</dd></div>)}</dl><ReadDetailCollection title="stats" value={stats.data ? [asRecord(stats.data)] : []} /><ReadDetailCollection title="versions" value={asRecord(versions.data).versions ?? versions.data} /></ReadState></section> : null}</section>;
}
export function UsersPage() { return <ListPage title="Users" search path={(query, page) => `/api/users?page=${page}&limit=20&q=${encodeURIComponent(query)}`} columns={[['username', 'Username'], ['role', 'Role'], ['status', 'Status'], ['lastLoginAt', 'Last login']]} detailPath={(row) => `/users/${encodeURIComponent(text(row.username))}`} />; }
export function UserDetailPage() { const { username } = useParams(); return <DetailPage title={`User ${username ?? ''}`} path={username ? `/api/users/${encodeURIComponent(username)}` : null} />; }
export function ReadBarChart({ rows }: { rows: UnknownRecord[] }) { const chartRows = useMemo(() => rows.slice(0, 8).map((row) => ({ name: text(row.name ?? row.plan_id ?? row.imsi), value: numberValue(row.count ?? row.total ?? row.value) })), [rows]); return <ResponsiveContainer width="100%" height={180}><BarChart data={chartRows}><XAxis dataKey="name" /><YAxis /><Tooltip /><Bar dataKey="value" fill="#1468d4" /></BarChart></ResponsiveContainer>; }
