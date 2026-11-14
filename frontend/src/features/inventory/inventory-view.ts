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
export const INVENTORY_POPULATIONS = ['operational', 'logical', 'all'] as const;
export type InventoryPopulation = (typeof INVENTORY_POPULATIONS)[number];
export type InventoryDensity = (typeof INVENTORY_DENSITIES)[number];
export const DEFAULT_INVENTORY_DENSITY: InventoryDensity = 'table';

/**
 * The default population is what an operator actually runs: NF instances and
 * standalone network elements. Logical NFs are a separate level and must not be
 * added to the same count, because one logical NF can own several instances.
 */
export const OPERATIONAL_POPULATION_KINDS = ['network_function_instance', 'network_element'] as const;
export const LOGICAL_POPULATION_KINDS = ['network_function'] as const;

/** Reads the overview population; an unknown value falls back to operational. */
export function readInventoryPopulation(value: string | null | undefined): InventoryPopulation {
  return INVENTORY_POPULATIONS.includes(value as InventoryPopulation)
    ? (value as InventoryPopulation)
    : 'operational';
}

/** Resolves the additive kinds filter for one population. */
export function inventoryPopulationKinds(population: InventoryPopulation): string[] {
  if (population === 'logical') return [...LOGICAL_POPULATION_KINDS];
  if (population === 'all') return [];
  return [...OPERATIONAL_POPULATION_KINDS];
}

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