import OcsBalancesPanel from "@/components/ocs/OcsBalancesPanel";
import "../ocs.css";

export const metadata = {
  title: "OCS Balances | Open5GS Subscriber Console",
  description: "Monitor subscriber quotas, balances, and balance invariant audits.",
};

export default function OcsBalancesPage() {
  return <OcsBalancesPanel />;
}
