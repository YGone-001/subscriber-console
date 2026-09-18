import OcsGovernanceDashboard from "@/components/ocs/dashboard/OcsGovernanceDashboard";
import "../ocs.css";

export const metadata = {
  title: "OCS Overview | xCloud Subscriber Console",
  description: "OCS governance operations overview with contract, tariff, and approval summaries.",
};

export default function OcsDashboardPage() {
  return <OcsGovernanceDashboard />;
}
