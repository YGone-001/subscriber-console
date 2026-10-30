/*
 * Inventory network-element overview (/inventory).
 *
 * The default inventory surface: one master-detail network-element view that
 * answers "what do I run, and what is wrong". The resource ledger lives at
 * /inventory/assets and local runtime observation at /inventory/runtime, so each
 * task owns one route instead of hiding behind a peer `view` token.
 *
 * Table and card wall are presentations of the same projection, not two
 * surfaces: `density` is a URL-persisted presentation key. Pre-split links
 * (`view=network|cards|assets|list|runtime`) are redirected once by
 * `inventoryLegacyRedirect` and are never emitted again.
 */
import { useSearchParams, Navigate, Link } from 'react-router-dom';
import { Boxes, Plus } from 'lucide-react';
import { hasPermission } from '../../lib/permissions';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { useAuth } from '../../providers/AuthProvider';
import { useI18n } from '../../providers/I18nProvider';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { useOperationsUrlState } from '../operations/use-operations-url-state';
import { INVENTORY_URL_KEYS } from '../operations/inventory-url-keys';
import NetworkElementView from './NetworkElementView';
import {
  INVENTORY_DENSITIES,
  inventoryLegacyRedirect,
  readInventoryDensity,
  type InventoryDensity,
} from './inventory-view';

function densityOptions(t: (key: string) => string): ViewSwitchOption<InventoryDensity>[] {
  return INVENTORY_DENSITIES.map((value) => ({
    value,
    label: t(value === 'cards' ? 'ops_view_cards' : 'ops_view_table'),
    data: { 'data-density': value },
  }));
}

export function InventoryPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();

  /* A pre-split link is redirected before the overview mounts, so it never
   * issues a projection read for a page it is not going to show. */
  const legacyTarget = inventoryLegacyRedirect(searchParams);
  const url = useOperationsUrlState({ keys: INVENTORY_URL_KEYS });
  const density = readInventoryDensity(url.filters.density);
  const canConfigure = hasPermission(user, 'core.configure');

  if (legacyTarget) {
    return <Navigate to={legacyTarget} replace />;
  }

  return (
    <OperationsPageFrame
      title={t('inventory_title')}
      description={t('inventory_description')}
      icon={<Boxes size={23} />}
      viewSwitch={(
        <ViewSwitch
          options={densityOptions(t)}
          value={density}
          onChange={(value) => url.setFilter('density', value)}
          ariaLabel={t('ops_view_density')}
        />
      )}
      actions={
        canConfigure ? (
          <Link to="/inventory/create" className="btn btn-primary">
            <Plus size={16} />
            {t('inventory_create_resource')}
          </Link>
        ) : undefined
      }
    >
      <NetworkElementView presentation={density} />
    </OperationsPageFrame>
  );
}

export default InventoryPage;
