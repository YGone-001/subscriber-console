import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Plus, RefreshCw, Search } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { EmptyState } from '../../components/ui/StatePanel';
import { SkeletonTable } from '../../components/ui/LoadingSkeleton';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { fetchInventoryMeta, fetchInventoryResources } from './inventory-api';
import type { MetaResponse, Resource } from './inventory-types';

export function InventoryPage() {
  const { t } = useI18n();
  const { user } = useAuth();

  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [selectedKind, setSelectedKind] = useState('');
  const [selectedDomain, setSelectedDomain] = useState('');
  const [selectedLifecycle, setSelectedLifecycle] = useState('');

  // Pagination cursor history
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const canConfigure = hasPermission(user, 'core.configure');

  useEffect(() => {
    fetchInventoryMeta()
      .then((data) => setMeta(data))
      .catch(() => {
        // Fallback or ignore meta fetch error
      });
  }, []);

  const loadResources = async (activeCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchInventoryResources({
        q: search.trim() || undefined,
        kind: selectedKind || undefined,
        domain: selectedDomain || undefined,
        lifecycleState: selectedLifecycle || undefined,
        cursor: activeCursor,
        limit: 20,
      });
      setResources(res.resources || []);
      setNextCursor(res.page?.nextCursor ?? null);
      setHasMore(Boolean(res.page?.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inventory resources.');
      setResources([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
    loadResources(undefined);
  }, [selectedKind, selectedDomain, selectedLifecycle]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCursor(undefined);
    setCursorHistory([]);
    loadResources(undefined);
  };

  const handleNextPage = () => {
    if (nextCursor) {
      setCursorHistory((prev) => [...prev, cursor ?? '']);
      setCursor(nextCursor);
      loadResources(nextCursor);
    }
  };

  const handleResetPagination = () => {
    setCursor(undefined);
    setCursorHistory([]);
    loadResources(undefined);
  };

  return (
    <div className="page-container">
      <header className="page-header flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('nav_inventory', { defaultValue: 'Inventory' })}</h1>
          <p className="text-sm text-muted-foreground">
            {t('inventory_description', { defaultValue: 'Authoritative source of truth for network and platform resource metadata.' })}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-secondary flex items-center gap-1.5"
            onClick={() => loadResources(cursor)}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            <span>{t('refresh', { defaultValue: 'Refresh' })}</span>
          </button>
          {canConfigure ? (
            <Link to="/inventory/create" className="btn-primary flex items-center gap-1.5">
              <Plus size={16} />
              <span>{t('inventory_create_resource', { defaultValue: 'Create Resource' })}</span>
            </Link>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="notice-banner notice-error mb-4" role="alert">
          {error}
        </div>
      ) : null}

      <div className="card p-4 mb-6">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap gap-3 items-center">
          <div className="flex-1 min-w-[200px] relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              className="input pl-9 w-full"
              placeholder={t('inventory_search_placeholder', { defaultValue: 'Search by ID or name prefix...' })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            className="input select"
            value={selectedKind}
            onChange={(e) => setSelectedKind(e.target.value)}
          >
            <option value="">{t('inventory_all_kinds', { defaultValue: 'All Kinds' })}</option>
            {meta?.kinds?.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <select
            className="input select"
            value={selectedDomain}
            onChange={(e) => setSelectedDomain(e.target.value)}
          >
            <option value="">{t('inventory_all_domains', { defaultValue: 'All Domains' })}</option>
            {meta?.domains?.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>

          <select
            className="input select"
            value={selectedLifecycle}
            onChange={(e) => setSelectedLifecycle(e.target.value)}
          >
            <option value="">{t('inventory_all_states', { defaultValue: 'All States' })}</option>
            {meta?.lifecycleStates?.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <button type="submit" className="btn-secondary">
            {t('search', { defaultValue: 'Search' })}
          </button>
        </form>
      </div>

      <div className="table-wrapper card overflow-hidden">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>{t('inventory_name', { defaultValue: 'Name' })}</th>
              <th>{t('inventory_kind', { defaultValue: 'Kind' })}</th>
              <th>{t('inventory_domain', { defaultValue: 'Domain' })}</th>
              <th>{t('inventory_role', { defaultValue: 'Role' })}</th>
              <th>{t('inventory_vendor', { defaultValue: 'Vendor / Model' })}</th>
              <th>{t('inventory_lifecycle', { defaultValue: 'Lifecycle' })}</th>
              <th>{t('inventory_updated_at', { defaultValue: 'Updated At' })}</th>
              <th className="text-right">{t('actions', { defaultValue: 'Actions' })}</th>
            </tr>
          </thead>
          <tbody>
            {loading && resources.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-8">
                  <SkeletonTable rows={5} />
                </td>
              </tr>
            ) : resources.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <EmptyState
                    title={t('empty_title', { defaultValue: 'Nothing to show' })}
                    description={t('inventory_empty_body', { defaultValue: 'No inventory resources match the current filters.' })}
                  />
                </td>
              </tr>
            ) : (
              resources.map((item) => (
                <tr key={item.resourceId} className="hover:bg-muted/50">
                  <td>
                    <div className="font-medium text-foreground">{item.name}</div>
                    {item.displayName ? (
                      <div className="text-xs text-muted-foreground">{item.displayName}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className="badge badge-outline">{item.kind}</span>
                  </td>
                  <td>
                    <span className="text-sm">{item.domain}</span>
                  </td>
                  <td>
                    <span className="text-sm text-muted-foreground">{item.role || '-'}</span>
                  </td>
                  <td>
                    <span className="text-sm text-muted-foreground">
                      {item.vendor || item.model ? `${item.vendor || ''} ${item.model || ''}`.trim() : '-'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        item.lifecycleState === 'active'
                          ? 'badge-success'
                          : item.lifecycleState === 'maintenance'
                          ? 'badge-warning'
                          : item.lifecycleState === 'retired'
                          ? 'badge-danger'
                          : 'badge-secondary'
                      }`}
                    >
                      {item.lifecycleState}
                    </span>
                  </td>
                  <td>
                    <span className="text-xs text-muted-foreground">
                      {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '-'}
                    </span>
                  </td>
                  <td className="text-right">
                    <Link
                      to={`/inventory/${encodeURIComponent(item.resourceId)}`}
                      className="btn-ghost btn-sm inline-flex items-center gap-1"
                    >
                      <span>{t('details', { defaultValue: 'Details' })}</span>
                      <ChevronRight size={14} />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-bar flex justify-between items-center mt-4">
        <div className="text-xs text-muted-foreground">
          {t('inventory_showing_resources', { count: resources.length, defaultValue: `Showing ${resources.length} resources` })}
        </div>
        <div className="flex gap-2">
          {cursorHistory.length > 0 ? (
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={handleResetPagination}
              disabled={loading}
            >
              {t('inventory_first_page', { defaultValue: 'First Page' })}
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleNextPage}
            disabled={!hasMore || !nextCursor || loading}
          >
            {t('next', { defaultValue: 'Next' })}
          </button>
        </div>
      </div>
    </div>
  );
}
