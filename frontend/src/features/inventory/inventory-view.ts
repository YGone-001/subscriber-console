/*
 * Inventory route resolution.
 *
 * The inventory workbench is split into three task-owning routes:
 *
 *   /inventory          network-element overview (table or card density)
 *   /inventory/assets   resource ledger
 *   /inventory/runtime  local runtime observation
 *
 * Pre-split links carried the task in a `view` query value. They stay readable
 * through one redirect table and are never emitted by the UI again. Density is
 * a presentation of the overview, not a peer task: it lives in its own
 * `density` key so `view=network` and `view=cards` can no longer be mistaken
 * for two different surfaces.
 */
import { sanitizeOperationsValue } from '../operations/operations-url-state';

export const INVENTORY_DENSITIES = ['table', 'cards'] as const;
export type InventoryDensity = (typeof INVENTORY_DENSITIES)[number];
export const DEFAULT_INVENTORY_DENSITY: InventoryDensity = 'table';

/** Reads the overview density; an unknown value falls back to the table. */
export function readInventoryDensity(value: string | null | undefined): InventoryDensity {
  return value === 'cards' ? 'cards' : DEFAULT_INVENTORY_DENSITY;
}

/**
 * Resolves a pre-split `/inventory?view=...` link into its canonical route.
 *
 * Returns null when the link already carries no legacy task value or carries
 * an unknown one (the shared URL contract drops unknown keys). Filters and the
 * cursor are preserved: only `view` is consumed.
 */
export function inventoryLegacyRedirect(search: string | URLSearchParams): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : new URLSearchParams(search);
  const view = sanitizeOperationsValue(params.get('view'));
  if (!view) return null;

  const next = new URLSearchParams(params);
  next.delete('view');

  let path: string;
  switch (view) {
    case 'network':
      path = '/inventory';
      break;
    case 'cards':
      path = '/inventory';
      if (!next.get('density')) next.set('density', 'cards');
      break;
    case 'assets':
    case 'list':
      path = '/inventory/assets';
      break;
    case 'runtime':
      path = '/inventory/runtime';
      break;
    default:
      return null;
  }

  const query = next.toString();
  return query ? `${path}?${query}` : path;
}
