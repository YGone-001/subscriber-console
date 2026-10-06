/*
 * OCS balance route container.
 *
 * The route now renders the forward-ported historical OCS balance placeholder,
 * which owns the presentation and calls the current read client, mutation client
 * and balance adapter directly. This file exists only to keep the router's import
 * path stable.
 */
import OcsBalancePlaceholder from '../../../components/ocs/balances/OcsBalancePlaceholder';

export function BalancesPage() {
  return <OcsBalancePlaceholder />;
}
