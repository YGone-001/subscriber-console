import OcsContractsPanel from "@/components/ocs/contracts/OcsContractsPanel";
import "../ocs.css";

export const metadata = {
  title: "OCS Contracts | xCloud Subscriber Console",
  description: "Manage OCS subscriber contracts with governance workflow.",
};

export default function OcsContractsPage() {
  return <OcsContractsPanel />;
}
