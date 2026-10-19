/*
 * Shared URL key set for the Inventory route.
 *
 * The route has two views that read and write the same query string: the asset
 * ledger and the network-element master-detail view. Each view owns a subset
 * (`state` is the ledger's lifecycle filter, `monitoring`/`node` belong to the
 * network view), but both must declare the full set: a patch keeps only
 * allow-listed keys, so a view that omitted the other view's keys would silently
 * erase them when the operator switches.
 */
export const INVENTORY_URL_KEYS = [
  'q',
  'kind',
  'domain',
  'state',
  'monitoring',
  'node',
] as const;

export type InventoryUrlKey = (typeof INVENTORY_URL_KEYS)[number];
