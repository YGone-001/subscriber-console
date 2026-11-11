/*
 * Inventory workbench switch: the resource ledger and host observation are
 * in-page views of the same Inventory tab, not separate sidebar destinations.
 * The three routes stay canonical and deep-linkable; this switch only moves
 * between them.
 */
import { useNavigate } from 'react-router-dom';
import { ViewSwitch, type ViewSwitchOption } from '../../components/ui/ViewSwitch';
import { useI18n } from '../../providers/I18nProvider';

type InventoryView = 'network' | 'assets' | 'runtime' | 'groups';

const TARGETS: Record<InventoryView, string> = {
  network: '/inventory',
  assets: '/inventory/assets',
  runtime: '/inventory/runtime',
  groups: '/inventory/groups',
};

export function InventoryViewSwitch({ active }: { active: InventoryView }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const options: ViewSwitchOption<InventoryView>[] = [
    { value: 'network', label: t('inventory_title'), data: { 'data-inventory-view': 'network' } },
    { value: 'assets', label: t('inventory_assets_title'), data: { 'data-inventory-view': 'assets' } },
    { value: 'runtime', label: t('inventory_runtime_title'), data: { 'data-inventory-view': 'runtime' } },
    { value: 'groups', label: t('groups_title'), data: { 'data-inventory-view': 'groups' } },
  ];

  return (
    <ViewSwitch
      options={options}
      value={active}
      onChange={(next) => navigate(TARGETS[next])}
      ariaLabel={t('inventory_view_switch_label')}
    />
  );
}
