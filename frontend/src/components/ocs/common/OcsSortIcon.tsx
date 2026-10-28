/*
 * Sort affordance shared by the OCS tables.
 *
 * `SortableTableHeader` requires an icon node, and the historical OCS tables
 * drew a bare arrow character in the header text. Reusing the same three-state
 * icon the profile table uses keeps the meaning ("sortable", "sorted up",
 * "sorted down") identical across the console.
 */
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

interface OcsSortIconProps {
  active: boolean;
  direction: 'asc' | 'desc';
}

export default function OcsSortIcon({ active, direction }: OcsSortIconProps) {
  if (!active) return <ArrowUpDown size={14} className="sort-icon muted" aria-hidden="true" />;
  return direction === 'asc'
    ? <ArrowUp size={14} className="sort-icon active" aria-hidden="true" />
    : <ArrowDown size={14} className="sort-icon active" aria-hidden="true" />;
}
