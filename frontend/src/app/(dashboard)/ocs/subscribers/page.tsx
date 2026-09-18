import OcsSubscribersPanel from "@/components/ocs/OcsSubscribersPanel";
import "../ocs.css";

export const metadata = {
  title: "OCS Subscribers | xCloud Subscriber Console",
  description: "OCS subscriber billing contracts, tariff bindings, and status.",
};

export default function OcsSubscribersPage() {
  return <OcsSubscribersPanel />;
}
