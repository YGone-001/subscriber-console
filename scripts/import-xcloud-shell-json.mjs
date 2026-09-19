import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import nextEnv from '@next/env';
import { BSON, MongoClient } from 'mongodb';

const { EJSON } = BSON;

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

const replaceDatabase = process.argv.includes('--replace');
const sourceDirectory = path.resolve(argumentValue('source') || path.join(process.cwd(), '..', 'xcloud'));
const databaseName = argumentValue('database') || 'xcloud';
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/xcloud';

if (['admin', 'config', 'local'].includes(databaseName)) {
  throw new Error(`Refusing to import into reserved MongoDB database "${databaseName}".`);
}

function convertShellBsonToExtendedJson(documentText, fileName, documentNumber) {
  const replacements = [
    [
      /ObjectId\(\s*"([0-9a-fA-F]{24})"\s*\)/g,
      (_match, value) => `{"$oid":"${value}"}`,
    ],
    [
      /NumberInt\(\s*"?(-?\d+)"?\s*\)/g,
      (_match, value) => `{"$numberInt":"${value}"}`,
    ],
    [
      /NumberLong\(\s*"?(-?\d+)"?\s*\)/g,
      (_match, value) => `{"$numberLong":"${value}"}`,
    ],
    [
      /ISODate\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\)/g,
      (_match, value) => `{"$date":"${value}"}`,
    ],
  ];

  let converted = documentText;
  for (const [pattern, replacement] of replacements) {
    converted = converted.replace(pattern, replacement);
  }

  const unsupportedConstructor = converted.match(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  if (unsupportedConstructor) {
    throw new Error(
      `${fileName} document ${documentNumber} contains unsupported BSON constructor: ${unsupportedConstructor[0]}`,
    );
  }

  try {
    return EJSON.parse(converted, { relaxed: false });
  } catch (error) {
    throw new Error(`${fileName} document ${documentNumber} is invalid after BSON conversion: ${error.message}`);
  }
}

function parseShellJsonDocuments(content, fileName) {
  if (!content.trim()) return [];

  const blocks = content
    .split(/(?=^\{\s*$)/m)
    .map((value) => value.trim())
    .filter(Boolean);

  return blocks.map((block, index) =>
    convertShellBsonToExtendedJson(block, fileName, index + 1),
  );
}

async function loadImportPlan() {
  const fileNames = (await readdir(sourceDirectory))
    .filter((fileName) => fileName.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));

  if (fileNames.length === 0) {
    throw new Error(`No .json collection files found in ${sourceDirectory}`);
  }

  const plan = [];
  for (const fileName of fileNames) {
    const collectionName = path.basename(fileName, path.extname(fileName));
    const content = await readFile(path.join(sourceDirectory, fileName), 'utf8');
    const documents = parseShellJsonDocuments(content, fileName);
    plan.push({ collectionName, fileName, documents });
  }
  return plan;
}

async function insertInBatches(collection, documents) {
  const batchSize = 500;
  for (let start = 0; start < documents.length; start += batchSize) {
    await collection.insertMany(documents.slice(start, start + batchSize), { ordered: true });
  }
}

async function main() {
  // Validate every source document before making any database changes.
  const plan = await loadImportPlan();
  const totalDocuments = plan.reduce((sum, entry) => sum + entry.documents.length, 0);
  console.log(`Validated ${totalDocuments} documents in ${plan.length} collection files from ${sourceDirectory}.`);

  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
  });

  await client.connect();
  try {
    const database = client.db(databaseName);
    const existingCollections = await database.listCollections({}, { nameOnly: true }).toArray();

    if (existingCollections.length > 0 && !replaceDatabase) {
      throw new Error(
        `Database "${databaseName}" already has ${existingCollections.length} collections. ` +
        'Pass --replace to replace that database after source validation.',
      );
    }

    if (existingCollections.length > 0) {
      await database.dropDatabase();
      console.log(`Dropped existing database "${databaseName}".`);
    }

    const imported = [];
    for (const entry of plan) {
      await database.createCollection(entry.collectionName);
      if (entry.documents.length > 0) {
        await insertInBatches(database.collection(entry.collectionName), entry.documents);
      }
      imported.push({ collection: entry.collectionName, documents: entry.documents.length });
      console.log(`${entry.collectionName}: imported ${entry.documents.length} documents`);
    }

    console.log(JSON.stringify({ ok: true, database: databaseName, totalDocuments, imported }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('xcloud import failed:', error);
  process.exitCode = 1;
});
