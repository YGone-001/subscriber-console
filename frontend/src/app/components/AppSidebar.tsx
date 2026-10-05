import { useMemo, useState } from 'react';
import { ChevronRight, Search, SidebarClose, SidebarOpen, X } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { getSidebarGroups, matchesRoute, type SidebarGroup } from '../../lib/navigation';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';

type SidebarEntry = SidebarGroup;

/**
 * Restored grouped sidebar.
 *
 * Groups and entries are resolved from the current navigation authority, so a
 * role that cannot reach a route never sees the corresponding entry. Grouping is
 * presentation only; the backend remains the security authority.
 */
export function AppSidebar({
  sidebarOpen,
  setSidebarOpen,
  isMobileShell,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: (value: boolean) => void;
  isMobileShell: boolean;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [filterQuery, setFilterQuery] = useState('');
  const [ocsExpanded, setOcsExpanded] = useState(true);
  const [systemExpanded, setSystemExpanded] = useState(true);

  const entries = useMemo<SidebarEntry[]>(() => getSidebarGroups(user?.role), [user?.role]);

  const filteredEntries = useMemo(() => {
    const needle = filterQuery.trim().toLowerCase();
    if (!needle) return entries;
    const result: SidebarEntry[] = [];
    for (const entry of entries) {
      const parentMatches = t(entry.key).toLowerCase().includes(needle);
      const children = entry.children ?? [];
      const matchingChildren = children.filter((child) => t(child.labelKey).toLowerCase().includes(needle));
      if (!parentMatches && matchingChildren.length === 0) continue;
      result.push({ ...entry, children: matchingChildren.length > 0 ? matchingChildren : entry.children });
    }
    return result;
  }, [entries, filterQuery, t]);

  const closeOnMobile = () => { if (isMobileShell) setSidebarOpen(false); };
  const isActivePath = (match: string) => matchesRoute(match, pathname) || (match !== '/' && pathname.startsWith(`${match}/`));

  return (
    <aside
      id="xcloud-primary-sidebar"
      className={`app-sidebar ${sidebarOpen ? 'expanded' : 'collapsed'}`}
      aria-label={t('navigation')}
      aria-hidden={isMobileShell && !sidebarOpen ? true : undefined}
    >
      {sidebarOpen ? (
        <div className="sidebar-filter-wrap">
          <Search size={14} className="sidebar-filter-icon" aria-hidden="true" />
          <input
            type="text"
            className="sidebar-filter-input"
            placeholder={t('sidebar_filter_ph')}
            aria-label={t('sidebar_filter_ph')}
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
          />
          {filterQuery ? (
            <button type="button" className="sidebar-filter-clear" onClick={() => setFilterQuery('')} title={t('clear')} aria-label={t('clear')}>
              <X size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      <nav className="sidebar-nav">
        {filteredEntries.map((entry) => {
          const children = entry.children ?? [];
          const childActive = children.some((child) => isActivePath(child.targetRoute));
          const active = childActive || isActivePath(entry.match);
          const expandable = children.length > 0;
          const expanded = entry.key === 'nav_ocs' ? (ocsExpanded || isActivePath('/ocs')) : (systemExpanded || isActivePath('/users'));
          const Icon = entry.icon;

          return (
            <div className="sidebar-item-wrap" key={entry.key}>
              {expandable ? (
                <>
                  <button
                    type="button"
                    className={`sidebar-link sidebar-parent-button${active ? ' active' : ''}`}
                    onClick={() => {
                      if (!sidebarOpen) { setSidebarOpen(true); return; }
                      if (entry.key === 'nav_ocs') setOcsExpanded((value) => !value);
                      else setSystemExpanded((value) => !value);
                    }}
                    aria-expanded={expanded}
                  >
                    <span className="sidebar-active-bar" aria-hidden="true" />
                    <span className="sidebar-icon" aria-hidden="true"><Icon size={20} /></span>
                    <span className="sidebar-label">{t(entry.key)}</span>
                    <span className="sidebar-tooltip" role="tooltip">{t(entry.key)}</span>
                    {sidebarOpen ? <ChevronRight size={16} className={expanded ? 'sidebar-chevron open' : 'sidebar-chevron'} aria-hidden="true" /> : null}
                  </button>
                  {sidebarOpen && expanded ? (
                    <div className="sidebar-subnav">
                      {children.map((child) => {
                        const ChildIcon = child.icon;
                        const childIsActive = isActivePath(child.targetRoute);
                        return (
                          <NavLink
                            key={child.targetRoute}
                            to={child.targetRoute}
                            className={`sidebar-link child${childIsActive ? ' active' : ''}`}
                            aria-current={childIsActive ? 'page' : undefined}
                            onClick={closeOnMobile}
                          >
                            <span className="sidebar-active-bar" aria-hidden="true" />
                            <span className="sidebar-icon" aria-hidden="true"><ChildIcon size={18} /></span>
                            <span className="sidebar-label">{t(child.labelKey)}</span>
                            <span className="sidebar-tooltip" role="tooltip">{t(child.labelKey)}</span>
                          </NavLink>
                        );
                      })}
                    </div>
                  ) : null}
                </>
              ) : (
                <NavLink
                  to={entry.target}
                  className={`sidebar-link${active ? ' active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={closeOnMobile}
                >
                  <span className="sidebar-active-bar" aria-hidden="true" />
                  <span className="sidebar-icon" aria-hidden="true"><Icon size={20} /></span>
                  <span className="sidebar-label">{t(entry.key)}</span>
                  <span className="sidebar-tooltip" role="tooltip">{t(entry.key)}</span>
                  {active && sidebarOpen ? <ChevronRight size={16} className="sidebar-chevron" aria-hidden="true" /> : null}
                </NavLink>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer-wrap">
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          title={sidebarOpen ? t('sidebar_collapse_hint') : t('sidebar_expand_hint')}
        >
          {sidebarOpen ? <SidebarClose size={16} /> : <SidebarOpen size={16} />}
          {sidebarOpen ? (
            <span className="sidebar-toggle-label">
              <span>{t('collapse_sidebar')}</span>
              <kbd className="sidebar-kbd">Ctrl B</kbd>
            </span>
          ) : null}
        </button>
      </div>
    </aside>
  );
}
