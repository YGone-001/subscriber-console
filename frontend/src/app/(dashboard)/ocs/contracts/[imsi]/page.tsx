import OcsContractDetail from "@/components/ocs/contracts/OcsContractDetail";
import "../../ocs.css";

export const metadata = {
  title: "OCS Contract Detail | xCloud Subscriber Console",
  description: "View OCS subscriber contract detail and governance status.",
};

export default async function OcsContractDetailPage({
  params,
}: {
  params: Promise<{ imsi: string }>;
}) {
  const { imsi } = await params;
  return <OcsContractDetail imsi={imsi} />;
}
