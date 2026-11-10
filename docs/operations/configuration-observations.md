# Configuration Observation Operations

The implementation is passive toward NFs. Activating it requires publishing the
matching Go binary and embedded SPA, declaring approved sources and configuring a
private fingerprint key. Source implementation alone does not enable collection
in an already running server.

## Prepare

1. Review `deploy/examples/config-snapshots.json`. It is a current-environment
   example containing 23 EPC/5GC sources and 38 IMS sources, with fixed intervals
   disabled. EPC/5GC currently uses `/usr/local/src/xcloud-5gs/install/etc`;
   IMS uses `/etc/xCloud/gcc/<NE>`, with explicitly listed files under the actual
   `icscf`, `pcscf`, `scscf` and `smsc` directories. Adjust these roots and each
   source path for the target installation. The paths are not product defaults.
   The example excludes OCS, TLS private keys/certificates, scripts, schemas,
   database directories and Git data.
2. Verify paths and read permission using the server's actual nonprivileged user.
   Do not grant root or broaden permissions merely to fill a dashboard.
3. Preserve the collector/source UUIDs across restarts of this controller; use new
   UUIDs for a different installation. Add resource UUIDs only when explicitly
   known. Unassociated sources remain valid file observations.
4. Install the reviewed declaration at an operator-owned path. Configure
   `CONFIG_SNAPSHOT_MANIFEST` to that path. The example is not imported implicitly.
5. Provision a private regular file containing at least 32 random bytes, readable
   by the server user and mode 0600 or stricter. Configure
   `CONFIG_SNAPSHOT_KEY_FILE`; never store its content in Git, a URL or a browser.

The feature validates the declaration/key independently. Invalid configuration
disables capture and reports unavailable readiness while old observations remain
readable. Existing platform functions continue using their previous configuration.

The original `root` field is backward compatible. Add other allowed directories
in `roots`, or use `roots` without `root`; there are at most 16 non-overlapping
roots. Do not set a broad common root merely to cover both EPC/5GC and IMS.
Every collected file must be explicitly declared under one root. Adding a new NE
requires reviewing its real files and adding its root/sources to the declaration,
not changing application code or granting arbitrary browser file access. Changing
an existing source path changes its generation and requires a compatible baseline.
Source names identify NE types for operator navigation; they do not infer resource
UUIDs or prove that a running process has loaded those configurations.

## Initialise and operate

Run the dedicated command with the existing deployment environment:

```sh
cd backend
go run ./cmd/config-snapshots-init
go run ./cmd/config-snapshots-init --apply
```

The first command is a dry-run. The second explicitly creates source/time indexes
in the Ops snapshot/observation collections. It performs no data migration or
source-file write and creates no TTL that could remove a protected baseline.

After publishing the application with the reviewed environment, use Platform
management -> Configuration snapshots. Collect a registered source, inspect the
safe fields and timestamp, then explicitly select a reference baseline. Retry a
revision conflict only after reloading and reviewing the current baseline.

For periodic observations, set an explicit `intervalSeconds` in the server-owned
declaration, in the supported 60..86400 range, and use the normal deployment
configuration lifecycle. There is no arbitrary command, file path or cron editor
in the browser. Due time is a plan for the current worker, not a guarantee that
every interval was measured.

## Failure and recovery

- Read failure: inspect source/read permission. The old successful snapshot is
  historical evidence; it is not replaced by an empty configuration.
- Metadata-only: the source is observed but has no approved content projection.
  Diameter configuration, IMS `format: "text"` sources and unrecognised structures
  are not raw-text downloads. IMS CFG/XML/CONF/LIST sources provide version and
  private change evidence; visible-field diffs require a separately reviewed
  projection policy. Unsupported encoding remains an explicit collection failure.
- Incompatible baseline: source identity/path/binding/profile or fingerprint key
  changed. Review the new evidence and explicitly choose a compatible baseline.
- Pending publication: storage interrupted a bounded write. A later authorized
  mutation or maintenance pass attempts recovery. GETs do not repair storage.
- Capacity refusal: inspect retention and protected references. Do not delete
  current baselines or alter collections directly as a UI workaround.
- Missing historical metric evidence: inspect the existing NF Health retention
  and collection coverage. Reports cannot reconstruct expired samples.

## Acceptance and rollback

Use the explicit isolated test flags to test against a test-owned mongod and the
approved sources, without writing production databases or source files:

```sh
cd backend
CONFIG_TEST_MONGOD=1 \
CONFIG_TEST_APPROVED_MANIFEST=/absolute/project/deploy/examples/config-snapshots.json \
go test -race -count=1 ./internal/configsnapshots ./internal/opsreports
```

The integration harness owns and stops its own Mongo process and temporary data
directory. Tests for changed content use isolated synthetic files, not real NF
configuration edits. Browser previews must be labelled DEMO/isolated evidence.

Application rollback uses the normal deployment artifact procedure. Disabling
the new declaration/schedules stops new captures; existing Ops history is retained.
Do not drop collections as part of rollback. Remote Agent configuration capture
remains a separate extension requiring an actual second host and valid HTTPS.
