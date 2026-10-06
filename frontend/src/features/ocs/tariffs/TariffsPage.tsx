/*
 * Tariff plan route container.
 *
 * The route now renders the forward-ported historical OCS tariff governance
 * panel, which owns the presentation and calls the current read client, mutation
 * client and tariff adapter directly. This file exists only to keep the router's
 * import path stable.
 */
import OcsTariffGovernancePanel from '../../../components/ocs/tariffs/OcsTariffGovernancePanel';

export function TariffsPage() {
  return <OcsTariffGovernancePanel />;
}
