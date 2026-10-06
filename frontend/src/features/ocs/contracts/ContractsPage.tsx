/*
 * OCS contract route container.
 *
 * The route now renders the forward-ported historical OCS contracts panel, which
 * owns the presentation and calls the current read client, mutation client and
 * contract adapter directly. This file exists only to keep the router's import
 * path stable.
 */
import OcsContractsPanel from '../../../components/ocs/contracts/OcsContractsPanel';

export function ContractsPage() {
  return <OcsContractsPanel />;
}
