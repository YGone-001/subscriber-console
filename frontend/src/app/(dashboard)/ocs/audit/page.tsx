import OcsAuditTimeline from "@/components/ocs/audit/OcsAuditTimeline";
import "../ocs.css";

export const metadata = {
  title: "OCS Audit | xCloud Subscriber Console",
  description: "View OCS operation audit trail and governance timeline.",
};

export default function OcsAuditPage() {
  return <OcsAuditTimeline />;
}
