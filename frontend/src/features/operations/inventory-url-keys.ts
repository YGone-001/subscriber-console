/*
 * Shared URL key set for the Inventory routes.
 *
 * The overview, the asset ledger and the runtime view read and write the same
 * query vocabulary: the overview owns `density`, `monitoring` and `node`, the
 * ledger owns `kind`, `domain` and `state`. Each surface declares the full set
 * because a patch keeps only allow-listed keys; a route that omitted another
 * surface's keys would erase them when the operator navigates.
 */
export const INVENTORY_URL_KEYS = [
  'q',
  'kind',
  'domain',
  'state',
  'monitoring',
  'node',
  'density',
] as const;

export type InventoryUrlKey = (typeof INVENTORY_URL_KEYS)[number];
