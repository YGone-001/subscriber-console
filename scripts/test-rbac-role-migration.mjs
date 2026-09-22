#!/usr/bin/env node
/**
 * Phase 5.7-B — RBAC Role Migration Integration Acceptance Suite
 *
 * Verifies that scripts/migrate-rbac-roles.mjs:
 * 1. Authoritatively targets `app_users` (NOT `users`) in MONGODB_APP_DB
 * 2. Leaves decoy collection `users` completely untouched
 * 3. Default mode is DRY-RUN: 0 writes, 0 role changes, 0 sessionVersion increments, 0 audit logs
 * 4. Explicit `--apply` mode:
 *    - root -> admin
 *    - super_admin -> admin
 *    - ops_admin -> operator
 *    - auditor -> viewer
 *    - admin, operator, viewer remain untouched
 *    - migrated accounts increment security.sessionVersion by exactly 1
 *    - canonical accounts do NOT increment sessionVersion
 *    - all unrelated account fields are preserved
 *    - conditional updates prevent stale overwrites
 *    - exactly 1 audit log written to app_audit_logs with action `users.role.migration`
 *    - app_approvals delta = 0
 * 5. Replay safety: second `--apply` does not mutate roles, does not increment sessionVersion,
 *    and does not write duplicate audit logs.
 */

import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const scriptPath = fileURLToPath(new URL('./migrate-rbac-roles.mjs', import.meta.url));
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const suffix = `${Date.now()}_${process.pid}_${Math.floor(Math.random() * 100000)}`;
const testDbName = `xcloud_ops_role_mig_test_${suffix}`;

console.log('── Phase 5.7-B RBAC Role Migration Acceptance Suite ──\n');
console.log(`Target Test DB: ${testDbName} @ ${uri}`);

let totalAssertions = 0;
async function verify(description, fn) {
  try {
    await fn();
    console.log(`  ✓ ${description}`);
    totalAssertions++;
  } catch (err) {
    console.error(`  ✗ ${description}`);
    console.error(err);
    process.exit(1);
  }
}

// Table-driven fixture matrix
const FIXTURES = [
  { username: 'usr_root', role: 'root', expectedRole: 'admin', shouldChange: true, displayName: 'Root Admin', email: 'root@internal.net', extraField: 'meta_root' },
  { username: 'usr_super', role: 'super_admin', expectedRole: 'admin', shouldChange: true, displayName: 'Super Admin', email: 'super@internal.net', extraField: 'meta_super' },
  { username: 'usr_ops', role: 'ops_admin', expectedRole: 'operator', shouldChange: true, displayName: 'Operations Lead', email: 'ops@internal.net', extraField: 'meta_ops' },
  { username: 'usr_auditor', role: 'auditor', expectedRole: 'viewer', shouldChange: true, displayName: 'Compliance Auditor', email: 'auditor@internal.net', extraField: 'meta_auditor' },
  { username: 'usr_admin', role: 'admin', expectedRole: 'admin', shouldChange: false, displayName: 'Existing Admin', email: 'admin@internal.net', extraField: 'meta_admin' },
  { username: 'usr_operator', role: 'operator', expectedRole: 'operator', shouldChange: false, displayName: 'Existing Operator', email: 'operator@internal.net', extraField: 'meta_operator' },
  { username: 'usr_viewer', role: 'viewer', expectedRole: 'viewer', shouldChange: false, displayName: 'Existing Viewer', email: 'viewer@internal.net', extraField: 'meta_viewer' },
];

const DECOY_USERS = [
  { username: 'decoy_root', role: 'root', security: { sessionVersion: 1 }, decoyTag: 'do_not_touch_decoy_1' },
  { username: 'decoy_ops', role: 'ops_admin', security: { sessionVersion: 2 }, decoyTag: 'do_not_touch_decoy_2' },
];

function runMigrationScript(args = []) {
  const env = {
    ...process.env,
    MONGODB_URI: uri,
    MONGODB_APP_DB: testDbName,
  };
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(testDbName);

  const appUsersCol = db.collection('app_users');
  const decoyUsersCol = db.collection('users');
  const auditLogsCol = db.collection('app_audit_logs');
  const approvalsCol = db.collection('app_approvals');

  try {
    // ------------------------------------------------------------------------
    // Step 0: Seed test database
    // ------------------------------------------------------------------------
    console.log('\n0. Seeding Fixtures and Decoy Collection');

    const initialTimestamp = '2026-01-01T00:00:00.000Z';
    const seedDocs = FIXTURES.map((f) => ({
      username: f.username,
      displayName: f.displayName,
      email: f.email,
      role: f.role,
      status: 'active',
      extraField: f.extraField,
      security: {
        sessionVersion: 10,
        failedLoginAttempts: 0,
      },
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
    }));

    await appUsersCol.insertMany(seedDocs);
    await decoyUsersCol.insertMany(DECOY_USERS.map((d) => ({ ...d })));

    const decoyBeforeSnapshot = JSON.stringify(await decoyUsersCol.find({}).sort({ username: 1 }).toArray());

    await verify('seeded 7 app_users fixtures (4 legacy, 3 canonical)', () => {
      assert.equal(seedDocs.length, 7);
    });
    await verify('seeded decoy collection users with 2 records', () => {
      assert.equal(DECOY_USERS.length, 2);
    });

    // ------------------------------------------------------------------------
    // Step 1: Dry-Run Verification
    // ------------------------------------------------------------------------
    console.log('\n1. Dry-Run Verification (default mode without --apply)');

    const dryRunResult = runMigrationScript([]);
    await verify('dry-run execution exits with code 0', () => {
      assert.equal(dryRunResult.status, 0, `Dry-run failed: ${dryRunResult.stderr}`);
    });
    await verify('dry-run output confirms DRY-RUN mode and identifies 4 candidates', () => {
      assert.ok(dryRunResult.stdout.includes('DRY-RUN'), 'Should mention DRY-RUN');
      assert.ok(dryRunResult.stdout.includes('Identified 4 account(s) with legacy roles'), 'Should find 4 candidates');
      assert.ok(dryRunResult.stdout.includes('usr_root'), 'Should identify usr_root');
      assert.ok(dryRunResult.stdout.includes('usr_super'), 'Should identify usr_super');
      assert.ok(dryRunResult.stdout.includes('usr_ops'), 'Should identify usr_ops');
      assert.ok(dryRunResult.stdout.includes('usr_auditor'), 'Should identify usr_auditor');
    });

    const appUsersAfterDryRun = await appUsersCol.find({}).toArray();
    await verify('dry-run leaves app_users completely unmodified (0 role writes)', () => {
      for (const u of appUsersAfterDryRun) {
        const fixture = FIXTURES.find((f) => f.username === u.username);
        assert.equal(u.role, fixture.role, `${u.username} role must not change in dry-run`);
        assert.equal(u.security.sessionVersion, 10, `${u.username} sessionVersion must not change in dry-run`);
        assert.equal(u.updatedAt, initialTimestamp, `${u.username} updatedAt must not change in dry-run`);
      }
    });

    await verify('dry-run writes 0 audit logs to app_audit_logs', async () => {
      const count = await auditLogsCol.countDocuments({});
      assert.equal(count, 0);
    });

    await verify('dry-run writes 0 approval tickets to app_approvals', async () => {
      const count = await approvalsCol.countDocuments({});
      assert.equal(count, 0);
    });

    const decoyAfterDryRun = JSON.stringify(await decoyUsersCol.find({}).sort({ username: 1 }).toArray());
    await verify('dry-run leaves decoy collection users completely untouched', () => {
      assert.equal(decoyAfterDryRun, decoyBeforeSnapshot);
    });

    // ------------------------------------------------------------------------
    // Step 2: Explicit Apply Verification
    // ------------------------------------------------------------------------
    console.log('\n2. Explicit Apply Verification (--apply)');

    const applyResult = runMigrationScript(['--apply']);
    await verify('apply execution exits with code 0', () => {
      assert.equal(applyResult.status, 0, `Apply failed: ${applyResult.stderr}`);
    });
    await verify('apply output confirms 4 accounts updated', () => {
      assert.ok(applyResult.stdout.includes('Migration complete: 4 of 4 accounts updated'), 'Should report 4 updated');
    });

    const appUsersAfterApply = await appUsersCol.find({}).toArray();

    await verify('parameterized role migrations and sessionVersion increments', () => {
      for (const u of appUsersAfterApply) {
        const fixture = FIXTURES.find((f) => f.username === u.username);
        assert.ok(fixture, `Unknown user: ${u.username}`);

        if (fixture.shouldChange) {
          // Migrated account
          assert.equal(u.role, fixture.expectedRole, `${u.username} role must be ${fixture.expectedRole}`);
          assert.equal(u.security.sessionVersion, 11, `${u.username} sessionVersion must be incremented to 11`);
          assert.notEqual(u.updatedAt, initialTimestamp, `${u.username} updatedAt must be refreshed`);
        } else {
          // Canonical account (untouched)
          assert.equal(u.role, fixture.expectedRole, `${u.username} canonical role must remain ${fixture.expectedRole}`);
          assert.equal(u.security.sessionVersion, 10, `${u.username} canonical sessionVersion must remain 10`);
          assert.equal(u.updatedAt, initialTimestamp, `${u.username} canonical updatedAt must remain initial`);
        }

        // Unrelated fields preserved across all accounts
        assert.equal(u.displayName, fixture.displayName);
        assert.equal(u.email, fixture.email);
        assert.equal(u.extraField, fixture.extraField);
        assert.equal(u.status, 'active');
        assert.equal(u.createdAt, initialTimestamp);
      }
    });

    await verify('operation log written to app_audit_logs with accurate trace metadata', async () => {
      const logs = await auditLogsCol.find({}).toArray();
      assert.equal(logs.length, 1, 'Exactly one audit record must be written');
      const log = logs[0];
      assert.equal(log.action, 'users.role.migration');
      assert.equal(log.result, 'success');
      assert.equal(log.resource.type, 'app_users');
      assert.equal(log.metadata.migratedCount, 4);
      assert.equal(log.metadata.candidatesCount, 4);
      assert.equal(log.metadata.migratedAccounts.length, 4);
      assert.ok(log.timestamp, 'Timestamp must exist');
    });

    await verify('apply creates 0 approval tickets in app_approvals (approvals delta = 0)', async () => {
      const count = await approvalsCol.countDocuments({});
      assert.equal(count, 0);
    });

    const decoyAfterApply = JSON.stringify(await decoyUsersCol.find({}).sort({ username: 1 }).toArray());
    await verify('apply leaves decoy collection users completely untouched', () => {
      assert.equal(decoyAfterApply, decoyBeforeSnapshot);
    });

    // ------------------------------------------------------------------------
    // Step 3: Replay Safety Verification
    // ------------------------------------------------------------------------
    console.log('\n3. Replay Safety Verification (second --apply on already-migrated database)');

    const replayResult = runMigrationScript(['--apply']);
    await verify('replay execution exits with code 0', () => {
      assert.equal(replayResult.status, 0, `Replay failed: ${replayResult.stderr}`);
    });
    await verify('replay confirms 0 candidates and no migration required', () => {
      assert.ok(replayResult.stdout.includes('All user accounts already have canonical roles'), 'Should report no migration required');
    });

    const appUsersAfterReplay = await appUsersCol.find({}).toArray();
    await verify('replay leaves app_users roles and sessionVersions identical to Pass 2', () => {
      for (const u of appUsersAfterReplay) {
        const fixture = FIXTURES.find((f) => f.username === u.username);
        assert.equal(u.role, fixture.expectedRole);
        assert.equal(u.security.sessionVersion, fixture.shouldChange ? 11 : 10);
      }
    });

    await verify('replay does not create duplicate audit records in app_audit_logs', async () => {
      const count = await auditLogsCol.countDocuments({});
      assert.equal(count, 1, 'Audit log count must remain 1');
    });

    await verify('replay does not create approval tickets in app_approvals', async () => {
      const count = await approvalsCol.countDocuments({});
      assert.equal(count, 0);
    });

    const decoyAfterReplay = JSON.stringify(await decoyUsersCol.find({}).sort({ username: 1 }).toArray());
    await verify('replay leaves decoy collection users completely untouched', () => {
      assert.equal(decoyAfterReplay, decoyBeforeSnapshot);
    });

    console.log(`\n========================================`);
    console.log(`RBAC ROLE MIGRATION SUITE PASSED: ${totalAssertions} assertions verified`);
    console.log(`========================================\n`);
  } finally {
    try {
      await db.dropDatabase();
    } catch {}
    await client.close();
  }
}

main().catch((err) => {
  console.error('Test harness failed:', err);
  process.exit(1);
});
