#!/usr/bin/env node
/**
 * Phase 5.7-B — RBAC Role Migration Utility
 *
 * Optional migration script to update legacy role values in the MongoDB `app_users` collection
 * to the canonical three-role model:
 *   - root, super_admin -> admin
 *   - ops_admin -> operator
 *   - auditor -> viewer
 *
 * Usage:
 *   node scripts/migrate-rbac-roles.mjs [--dry-run]
 *   node scripts/migrate-rbac-roles.mjs --apply
 *   node scripts/migrate-rbac-roles.mjs --help
 *
 * Safety defaults:
 *   - Defaults to dry-run mode (no database writes).
 *   - Requires explicit `--apply` flag to commit changes.
 */

import { MongoClient } from 'mongodb';
import nextEnv from '@next/env';
import { randomUUID } from 'node:crypto';

nextEnv.loadEnvConfig(process.cwd());

const LEGACY_ROLE_MAP = {
  root: 'admin',
  super_admin: 'admin',
  ops_admin: 'operator',
  auditor: 'viewer',
};

function printHelp() {
  console.log(`
RBAC Role Migration Utility (Phase 5.7-B)

Maps legacy role values in the application user collection (app_users) to canonical three-role names:
  root         -> admin
  super_admin  -> admin
  ops_admin    -> operator
  auditor      -> viewer

Options:
  --dry-run    (Default) Inspect and report accounts needing migration without modifying the DB.
  --apply      Commit role updates to the database and write an audit record.
  --help       Show this help message.

Environment Variables:
  MONGODB_URI      MongoDB connection URI (default: mongodb://127.0.0.1:27017)
  MONGODB_APP_DB   Application DB name (default: xcloud_ops)
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const isApply = args.includes('--apply');
  const isDryRun = !isApply || args.includes('--dry-run');

  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const dbName = process.env.MONGODB_APP_DB || process.env.MONGODB_XCLOUD_DB || 'xcloud_ops';

  console.log(`Mode: ${isDryRun ? 'DRY-RUN (no changes will be committed)' : 'APPLY (changes will be committed)'}`);
  console.log(`Database: ${dbName} @ ${uri}\n`);

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const usersCol = db.collection('app_users');
    const auditCol = db.collection('app_audit_logs');

    // Find all users
    const allUsers = await usersCol.find({}).toArray();
    console.log(`Found ${allUsers.length} total user accounts in database.`);

    const candidates = [];
    for (const u of allUsers) {
      if (LEGACY_ROLE_MAP[u.role]) {
        candidates.push({
          username: u.username,
          currentRole: u.role,
          canonicalRole: LEGACY_ROLE_MAP[u.role],
          status: u.status,
        });
      }
    }

    if (candidates.length === 0) {
      console.log('✓ All user accounts already have canonical roles. No migration required.');
      process.exit(0);
    }

    console.log(`\nIdentified ${candidates.length} account(s) with legacy roles:`);
    for (const c of candidates) {
      console.log(`  - [${c.username}] ${c.currentRole} -> ${c.canonicalRole} (status: ${c.status})`);
    }

    if (isDryRun) {
      console.log('\n[DRY-RUN] No updates were made to the database.');
      console.log('To apply these changes, rerun with `--apply`.');
      process.exit(0);
    }

    // Apply migrations
    console.log('\nApplying role migrations...');
    let updatedCount = 0;
    const now = new Date().toISOString();

    for (const c of candidates) {
      const result = await usersCol.updateOne(
        { username: c.username, role: c.currentRole },
        {
          $set: {
            role: c.canonicalRole,
            updatedAt: now,
          },
          $inc: {
            'security.sessionVersion': 1,
          },
        }
      );

      if (result.modifiedCount > 0) {
        updatedCount++;
        console.log(`  ✓ Updated ${c.username}: ${c.currentRole} -> ${c.canonicalRole}`);
      }
    }

    if (updatedCount > 0) {
      // Record audit log entry
      const auditRecord = {
        id: randomUUID(),
        eventId: `EVT-${randomUUID()}`,
        timestamp: now,
        level: 'info',
        action: 'users.role.migration',
        actor: { type: 'system', username: 'migration_script' },
        resource: { type: 'app_users', id: 'all' },
        result: 'success',
        riskLevel: 'medium',
        metadata: {
          migratedCount: updatedCount,
          candidatesCount: candidates.length,
          migratedAccounts: candidates.map((c) => ({ username: c.username, from: c.currentRole, to: c.canonicalRole })),
        },
      };

      try {
        await auditCol.insertOne(auditRecord);
        console.log(`  ✓ Audit record recorded (action: users.role.migration)`);
      } catch (auditErr) {
        console.warn(`  ! Could not record audit record: ${auditErr.message}`);
      }
    }

    console.log(`\nMigration complete: ${updatedCount} of ${candidates.length} accounts updated.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
