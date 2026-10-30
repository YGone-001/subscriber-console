/*
 * Runtime observation (/inventory/runtime).
 *
 * The local process plane is its own route: it answers "which expected
 * components are running on this host", a question that does not belong to the
 * resource ledger or to the network-element view. The surface is read-only
 * except for the governed bootstrap dialog owned by RuntimeDiscoveryView.
 */
import { Server } from 'lucide-react';
import { useI18n } from '../../providers/I18nProvider';
import { OperationsPageFrame } from '../operations/OperationsPageFrame';
import { RuntimeDiscoveryView } from '../runtime/RuntimeDiscovery';

export function InventoryRuntimePage() {
  const { t } = useI18n();

  return (
    <OperationsPageFrame
      title={t('inventory_runtime_title')}
      description={t('inventory_runtime_description')}
      icon={<Server size={23} />}
    >
      <RuntimeDiscoveryView />
    </OperationsPageFrame>
  );
}

export default InventoryRuntimePage;
