import OcsSessionsPanel from "@/components/ocs/OcsSessionsPanel";
import "../ocs.css";

export const metadata = {
  title: "OCS Diameter Sessions | Open5GS Subscriber Console",
  description: "Real-time Gy / Ro Diameter session state machine and quota authorization monitor.",
};

export default function OcsSessionsPage() {
  return <OcsSessionsPanel />;
}
