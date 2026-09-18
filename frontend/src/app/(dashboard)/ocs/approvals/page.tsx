import OcsApprovalsPanel from "@/components/ocs/approvals/OcsApprovalsPanel";
import "../ocs.css";

export const metadata = {
  title: "OCS Approvals | xCloud Subscriber Console",
  description: "View and manage OCS governance approval requests.",
};

export default function OcsApprovalsPage() {
  return <OcsApprovalsPanel />;
}
