/*
 * OCS balance detail route container.
 *
 * The route now renders the forward-ported historical OCS balance detail, which
 * reads `/api/ocs/balances?imsi=...` through the current read client and the typed
 * balance adapter. This file exists only to keep the router's import path stable
 * and to supply the raw route parameter.
 */
import { useParams } from 'react-router-dom';
import OcsBalanceDetail from '../../../components/ocs/balances/OcsBalanceDetail';

export function BalanceDetailPage() {
  const { imsi } = useParams();
  return <OcsBalanceDetail imsi={imsi ?? ''} />;
}
