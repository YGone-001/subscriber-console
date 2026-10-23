/*
 * Screen-reader status channel for a topology workspace.
 *
 * The visible summary is optimized for sighted scanning; this live region
 * announces the same facts (loaded counts, active filters, hidden roles and the
 * current selection) without duplicating them visually.
 */
export function TopologyAnnouncer({ message }: { message: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" data-topology-announcer="true">
      {message}
    </p>
  );
}

export default TopologyAnnouncer;
