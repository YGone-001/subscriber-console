import OcsDashboard from "@/components/ocs/OcsDashboard";
import "../ocs.css";

export const metadata = {
  title: "OCS Dashboard | xCloud Subscriber Console",
  description: "OCS management overview with subscriber, tariff, and balance summaries.",
};

export default function OcsDashboardPage() {
  return <OcsDashboard />;
}
