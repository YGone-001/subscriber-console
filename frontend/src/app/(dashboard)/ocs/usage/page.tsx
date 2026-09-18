import OcsUsagePanel from "@/components/ocs/OcsUsagePanel";
import "../ocs.css";

export const metadata = {
  title: "OCS Usage & Reservations | xCloud Subscriber Console",
  description: "Audit trail for CCR-U / CCR-T CDR usage records and active quota reservations.",
};

export default function OcsUsagePage() {
  return <OcsUsagePanel />;
}
