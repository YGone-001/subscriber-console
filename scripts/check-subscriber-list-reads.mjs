/*
 * Read-only diagnosis for the subscriber list read path.
 *
 * GET /api/subscribers?detail=true currently builds every matching row in memory
 * before it paginates, so the cost of one page is a function of the whole
 * subscriber collection. This script measures what the storage layer is actually
 * asked to do: which indexes exist, how many documents each representative
 * predicate examines, and whether the planner falls back to a collection scan.
 *
 * It performs no writes, creates no indexes and prints no credentials. Run it on
 * the application host:
 *
 *   node scripts/check-subscriber-list-reads.mjs
 */
import { MongoClient } from 'mongodb';
import { loadEnv } from './lib/load-env.mjs';

loadEnv(process.cwd());

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';
const xcloudDbName = process.env.MONGODB_XCLOUD_DB || 'xcloud';

const client = new MongoClient(uri, {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
});

function stageNames(plan, acc = []) {
  if (!plan || typeof plan !== 'object') return acc;
  if (typeof plan.stage === 'string') acc.push(plan.stage);
  if (plan.inputStage) stageNames(plan.inputStage, acc);
  if (plan.inputStages) plan.inputStages.forEach((stage) => stageNames(stage, acc));
  if (plan.queryPlan) stageNames(plan.queryPlan, acc);
  return acc;
}

/*
 * explain() reports the plan the server would use for this predicate. It is a
 * read-only command: the query is described, not committed.
 */
async function explainFind(db, collection, filter, sort, skip, limit) {
  const result = await db.command({
    explain: {
      find: collection,
      filter,
      sort,
      skip,
      limit,
    },
    verbosity: 'executionStats',
  });

  const winningPlan = result.queryPlanner?.winningPlan ?? {};
  const stats = result.executionStats ?? {};
  const stages = stageNames(winningPlan);
  const indexName = (() => {
    const collect = (plan, acc = []) => {
      if (!plan || typeof plan !== 'object') return acc;
      if (typeof plan.indexName === 'string') acc.push(plan.indexName);
      if (plan.inputStage) collect(plan.inputStage, acc);
      if (plan.inputStages) plan.inputStages.forEach((stage) => collect(stage, acc));
      if (plan.queryPlan) collect(plan.queryPlan, acc);
      return acc;
    };
    return collect(winningPlan)[0] ?? 'none';
  })();

  return {
    stages,
    indexName,
    collectionScan: stages.includes('COLLSCAN'),
    docsExamined: stats.totalDocsExamined ?? null,
    keysExamined: stats.totalKeysExamined ?? null,
    returned: stats.nReturned ?? null,
    executionTimeMillis: stats.executionTimeMillis ?? null,
  };
}

function printCase(name, measurement) {
  console.log('');
  console.log(`case=${name}`);
  console.log(`  index=${measurement.indexName}`);
  console.log(`  stages=${measurement.stages.join('>') || 'unknown'}`);
  console.log(`  collection_scan=${measurement.collectionScan}`);
  console.log(`  docs_examined=${measurement.docsExamined}`);
  console.log(`  keys_examined=${measurement.keysExamined}`);
  console.log(`  returned=${measurement.returned}`);
  console.log(`  execution_ms=${measurement.executionTimeMillis}`);
}

async function describeCollection(db, name) {
  const collection = db.collection(name);
  let count = null;
  try {
    count = await collection.estimatedDocumentCount();
  } catch (error) {
    if (error?.code !== 26 && error?.codeName !== 'NamespaceNotFound') throw error;
  }
  let indexes = [];
  try {
    indexes = (await collection.indexes()).map((index) => ({
      name: index.name,
      key: index.key,
      unique: Boolean(index.unique),
      partial: Boolean(index.partialFilterExpression),
    }));
  } catch (error) {
    if (error?.code !== 26 && error?.codeName !== 'NamespaceNotFound') throw error;
  }
  console.log('');
  console.log(`collection=${name} documents=${count}`);
  if (indexes.length === 0) {
    console.log('  indexes=<none>');
  }
  for (const index of indexes) {
    console.log(`  index name=${index.name} key=${JSON.stringify(index.key)} unique=${index.unique} partial=${index.partial}`);
  }
  return indexes;
}

async function main() {
  await client.connect();
  const db = client.db(xcloudDbName);

  console.log('subscriber_list_read_diagnosis=start');
  console.log(`database=${xcloudDbName}`);

  const subscriberIndexes = await describeCollection(db, 'subscribers');
  await describeCollection(db, 'ocs_subscribers');
  await describeCollection(db, 'ocs_balances');
  await describeCollection(db, 'ocs_tariff_plans');

  const hasIndexOn = (field) => subscriberIndexes.some((index) => Object.keys(index.key).join(',') === field);
  const hasImsiIndex = hasIndexOn('imsi');
  const hasStatusIndex = hasIndexOn('access_restriction_data');
  const hasProfileIndex = hasIndexOn('webui_meta.profile_name');

  /*
   * The three predicates below mirror what the list endpoint actually sends for
   * the default page, for an access-status facet, and for the template facet.
   */
  const cases = [
    {
      name: 'default_page',
      filter: {},
      sort: { imsi: 1 },
    },
    {
      name: 'imsi_prefix_search',
      filter: { imsi: { $regex: '^460' } },
      sort: { imsi: 1 },
    },
    {
      name: 'access_status_active',
      /* statusFromARD: Active is an absent value, 0, or 32. */
      filter: {
        $or: [
          { access_restriction_data: { $exists: false } },
          { access_restriction_data: { $in: [0, 32] } },
        ],
      },
      sort: { imsi: 1 },
    },
    {
      name: 'template_attribution',
      filter: {
        $or: [
          { 'webui_meta.profile_name': 'template-name' },
          { 'webui_meta.profile': 'template-name' },
          { profile_name: 'template-name' },
          { profile: 'template-name' },
        ],
      },
      sort: { imsi: 1 },
    },
  ];

  const results = [];
  for (const testCase of cases) {
    try {
      const measurement = await explainFind(db, 'subscribers', testCase.filter, testCase.sort, 0, 20);
      printCase(testCase.name, measurement);
      results.push({ ...testCase, ...measurement });
    } catch (error) {
      console.log('');
      console.log(`case=${testCase.name}`);
      console.log(`  error=${error?.message ?? error}`);
      results.push({ name: testCase.name, error: true });
    }
  }

  console.log('');
  console.log('index_coverage:');
  console.log(`  subscriber_imsi_index=${hasImsiIndex}`);
  console.log(`  subscriber_access_restriction_index=${hasStatusIndex}`);
  console.log(`  subscriber_profile_attribution_index=${hasProfileIndex}`);

  const scans = results.filter((result) => result.collectionScan).map((result) => result.name);
  const slowest = results.reduce(
    (worst, result) => (typeof result.executionTimeMillis === 'number' && result.executionTimeMillis > (worst?.executionTimeMillis ?? -1) ? result : worst),
    null,
  );

  console.log('');
  console.log(`collection_scan_cases=${scans.length === 0 ? 'none' : scans.join(',')}`);
  console.log(`slowest_case=${slowest?.name ?? 'n/a'} time_ms=${slowest?.executionTimeMillis ?? 'n/a'}`);
  console.log('subscriber_list_read_diagnosis=done');
}

main()
  .catch((error) => {
    console.error('subscriber_list_read_diagnosis=failed');
    console.error(`error=${error?.message ?? error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
