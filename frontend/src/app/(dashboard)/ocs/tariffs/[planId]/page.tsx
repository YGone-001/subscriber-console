import OcsTariffDetail from "@/components/ocs/tariffs/OcsTariffDetail";
import "../../ocs.css";

export const metadata = {
  title: "OCS Tariff Detail | xCloud Subscriber Console",
  description: "View OCS tariff plan detail, quota configuration, and governance status.",
};

export default async function OcsTariffDetailPage({
  params,
}: {
  params: Promise<{ planId: string }>;
}) {
  const { planId } = await params;
  return <OcsTariffDetail planId={planId} />;
}
