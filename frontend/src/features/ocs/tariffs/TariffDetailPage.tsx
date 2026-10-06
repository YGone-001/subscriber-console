/*
 * Tariff plan detail route container.
 *
 * The route now renders the forward-ported historical OCS tariff detail, which
 * reads `/api/tariff-plans/{planId}` and its rules/subscribers companions through
 * the current read client and the typed tariff adapter. This file exists only to
 * keep the router's import path stable and to supply the raw route parameter.
 */
import { useParams } from 'react-router-dom';
import OcsTariffDetail from '../../../components/ocs/tariffs/OcsTariffDetail';

export function TariffDetailPage() {
  const { planId } = useParams();
  return <OcsTariffDetail planId={planId ?? ''} />;
}
