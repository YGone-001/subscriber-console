/**
 * Business-collection index specifications.
 *
 * This is the single source of truth for the indexes that both the full
 * initializer and the index-only migration manage. Keep definitions here rather
 * than duplicating them in either script.
 *
 * `profile_updated_at_desc` is included because the template list sorts by
 * updated_at; it was present in the live lab collection but was missing from the
 * initializer, which made a fresh database slower than an already-used one.
 */
export const BUSINESS_INDEX_SPECS = [
  {
    database: 'xcloud',
    collection: 'subscribers',
    indexes: [
      { key: { imsi: 1 }, unique: true, name: 'uniq_imsi' },
      { key: { msisdn: 1 }, name: 'subscriber_msisdn' },
    ],
  },
  {
    database: 'xcloud',
    collection: 'ocs_subscribers',
    indexes: [
      { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_subscriber_imsi' },
      { key: { plan_id: 1 }, name: 'ocs_subscriber_plan_id' },
      { key: { msisdn: 1 }, name: 'ocs_subscriber_msisdn' },
    ],
  },
  {
    database: 'xcloud',
    collection: 'ocs_balances',
    indexes: [
      { key: { imsi: 1 }, unique: true, name: 'uniq_ocs_balance_imsi' },
      { key: { updated_at: -1 }, name: 'ocs_balance_updated_at_desc' },
    ],
  },
  {
    database: 'xcloud_ops',
    collection: 'app_profiles',
    indexes: [
      { key: { name: 1 }, unique: true, name: 'uniq_profile_name' },
      { key: { updated_at: -1 }, name: 'profile_updated_at_desc' },
    ],
  },
];
