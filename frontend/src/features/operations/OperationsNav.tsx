/*
 * Operational workspace navigation.
 *
 * One tab strip shared by the five network-operation surfaces, so the operator
 * reads them as one workbench instead of five unrelated tables. It adds no route
 * and changes no destination: every tab points at the existing canonical route,
 * and nested detail routes keep their owning tab active.
 *
 * The strip scrolls horizontally on narrow viewports; the active tab keeps a
 * visible focus ring and an `aria-current` marker so the current surface is never
 * only implied by colour.
 */
import { NavLink } from 'react-router-dom';
import { BellRing, Boxes, HeartPulse, Network, Radar } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import styles from '../../styles/modules/operations-nav.module.css';

const TABS = [
  { to: '/inventory', labelKey: 'nav_inventory', icon: Boxes },
  { to: '/topology', labelKey: 'nav_topology', icon: Network },
  { to: '/discovery', labelKey: 'nav_discovery', icon: Radar },
  { to: '/nf-health', labelKey: 'nav_nf_health', icon: HeartPulse },
  { to: '/nf-alerts', labelKey: 'nav_nf_alerts', icon: BellRing },
];

export function OperationsNav() {
  const { t } = useI18n();
  return (
    <nav className={styles.nav} aria-label={t('ops_nav_label')} data-operations-nav="workbench">
      {TABS.map(({ to, labelKey, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
        >
          <Icon size={15} aria-hidden="true" />
          <span>{t(labelKey)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export default OperationsNav;
