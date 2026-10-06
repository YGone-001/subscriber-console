/*
 * OCS contract detail route container.
 *
 * The route now renders the forward-ported historical OCS contract detail, which
 * reads `/api/ocs/subscribers?imsi=...` through the current read client and the
 * typed contract adapter. This file exists only to keep the router's import path
 * stable and to supply the raw route parameter.
 */
import { useParams } from 'react-router-dom';
import OcsContractDetail from '../../../components/ocs/contracts/OcsContractDetail';

export function ContractDetailPage() {
  const { imsi } = useParams();
  return <OcsContractDetail imsi={imsi ?? ''} />;
}
