import OcsBalanceDetail from "@/components/ocs/balances/OcsBalanceDetail";
import "../../ocs.css";

export const metadata = {
  title: "OCS Balance Detail | xCloud Subscriber Console",
  description: "View OCS subscriber balance detail, quota buckets, and governance status.",
};

export default async function OcsBalanceDetailPage({
  params,
}: {
  params: Promise<{ imsi: string }>;
}) {
  const { imsi } = await params;
  return <OcsBalanceDetail imsi={imsi} />;
}
