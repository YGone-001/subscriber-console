import { useEffect, useRef } from 'react';
/*
 * Operational workspace navigation.
 *
 * One tab strip shared by the network-operation surfaces, so the operator
 * reads them as one workbench instead of unrelated tables. It adds no route
 * and changes no destination: every tab points at the existing canonical route,
 * and nested detail routes keep their owning tab active.
 *
 * The strip scrolls horizontally on narrow viewports; the active tab keeps a
 * visible focus ring and an `aria-current` marker so the current surface is never
 * only implied by colour.
 */
import { NavLink, useLocation } from 'react-router-dom';
import { BellRing, Boxes, ChevronDown, HeartPulse, Network, Radar, SearchCheck, Users } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import styles from '../../styles/modules/operations-nav.module.css';

const TABS = [
  { to: '/inventory', labelKey: 'nav_inventory', icon: Boxes },
  { to: '/topology', labelKey: 'nav_topology', icon: Network },
  { to: '/discovery', labelKey: 'nav_discovery', icon: Radar },
  { to: '/nf-health', labelKey: 'nav_nf_health', icon: HeartPulse },
  { to: '/nf-alerts', labelKey: 'nav_nf_alerts', icon: BellRing },
  { to: '/investigations', labelKey: 'inv_title', icon: SearchCheck },
  { to: '/ue-info', labelKey: 'nav_ue_info', icon: Users },
];

export function OperationsNav() {
  const { t } = useI18n();
  const pathname = useLocation().pathname;
  const ims = pathname === '/ims-registrations';
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = navRef.current;
    const align = () => {
      const active = element?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!element || !active) return;
      const activeBounds = active.getBoundingClientRect();
      const navBounds = element.getBoundingClientRect();
      element.scrollLeft += activeBounds.left - navBounds.left + (activeBounds.width - element.clientWidth) / 2;
    };
    align();
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(align);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pathname]);
  return (
    <nav ref={navRef} className={styles.nav} aria-label={t('ops_nav_label')} data-operations-nav="workbench">
      {TABS.map(({ to, labelKey, icon: Icon }) => (
        <NavLink
          key={to}
          to={to === '/ue-info' && ims ? '/ims-registrations' : to}
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Icon size={15} aria-hidden="true" />
          <span>{t(labelKey)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Canvas-mode navigation: the same destinations behind one disclosure, so a
 * graph page keeps a single-row header without losing the way to its sibling
 * operations surfaces.
 */
export function OperationsNavCompact() {
  const { t } = useI18n();
  const ims = useLocation().pathname === '/ims-registrations';
  return (
    <details className={styles.compact} data-operations-nav="compact">
      <summary className={styles.compactSummary}>
        <Boxes size={15} aria-hidden="true" />
        <span>{t('ops_nav_compact')}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <nav className={styles.compactMenu} aria-label={t('ops_nav_label')}>
        {TABS.map(({ to, labelKey, icon: Icon }) => (
          <NavLink
            key={to}
            to={to === '/ue-info' && ims ? '/ims-registrations' : to}
            aria-label={t(labelKey)}
            className={({ isActive }) => `${styles.compactLink} ${isActive ? styles.compactLinkActive : ''}`}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{t(labelKey)}</span>
          </NavLink>
        ))}
      </nav>
    </details>
  );
}

export default OperationsNav;
