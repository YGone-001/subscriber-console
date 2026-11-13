# Configuration Observations

Status: implemented in source. Publishing a new server binary and activating an
operator-owned source declaration are deployment actions, separate from source
implementation and isolated acceptance.

## Ownership and evidence

`backend/internal/configsnapshots` owns local, bounded file observations. It does
not configure or restart a network function. Inventory retains resource identity;
no resource, relation, monitoring target or business document is created from a
file or process name. A declared file does not prove a running NF loaded it.

The UI routes are `/config-snapshots` and `/config-snapshots/:sourceId`. They
compose the console primitives, cookie session and shared read/mutation clients.
Operators and admins with `core.configure` may collect an already declared source
and set/clear its reference baseline. Both actions revalidate the fresh actor.
Viewing requires `core.read`. Viewer mutations return 403. Auditing is best-effort.

## Declaration and privacy

`CONFIG_SNAPSHOT_MANIFEST` names an absolute JSON declaration. The declaration
contains a stable local collector UUID, at most 16 non-overlapping absolute roots
and at most 128 sources. The original `root` field remains supported; the optional
`roots` array adds independent permitted directories or replaces `root` entirely.
Every source resolves to exactly one permitted root before collection. Adding
another root preserves existing source generations and baselines when their
identity/path/profile stay the same. Neither paths nor root declarations are
compiled defaults; operators must adjust them for each deployment.
Each source has a UUID, display name, absolute regular-file path under the root,
format, approved projection profile and optional explicit Inventory UUID.
The browser supplies source IDs, never file paths or commands. Paths remain
server-side. Symbolic links, special files, out-of-root paths, changed file
identities, unsupported encoding and files over 1 MiB are rejected.

`deploy/examples/config-snapshots.json` is the reviewed package-layout example, with root `/etc/xCloud` and 54 explicitly declared YAML, Diameter and metadata-only text candidates. EPC/5GC paths use `gnc/gdm/gdg/gpc/gsp`; CSCF/SMSC paths use `gcc`, and IPSMGW uses `gnc/ipsmgw`. It excludes keys, certificates, database files, scripts, schemas and `/etc/ld.so.conf.d` helper declarations. Names and directory labels never establish Inventory identity: resource UUIDs must be explicit. The example is not auto-loaded and collection never recursively discovers files. The explicitly selected older source-tree layout remains in `deploy/examples/config-snapshots-source-tree.json`; it is not a default or automatic fallback.

[Configuration drift](configuration-drift.md) adds a separately ordered, policy-controlled comparison lifecycle. Observation.changed continues to mean adjacent-observation change. Collectors on other installations require stable UUIDs and reviewed path/resource associations.

The `network-endpoints-v1` profile parses YAML/JSON with the YAML organization's
maintained [`go.yaml.in/yaml/v3` parser](https://pkg.go.dev/go.yaml.in/yaml/v3@v3.0.6). It rejects aliases, custom tags, duplicate
keys, excess depth/nodes and ambiguous documents. Only positively approved
network endpoint/session fields and logger level are projected. Unknown fields,
comments, database URIs, security configuration and credential-bearing URLs are
omitted. The output is a deterministic JSON projection, not the original config.
Diameter and other unprojectable documents remain metadata-only. IMS CFG/XML and
other approved UTF-8 configuration files use `format: "text"` with the mandatory
`metadata-only-v1` profile. This retains collection time, byte size, private change
evidence and version/baseline history without parsing or displaying IMS secrets.
It does not provide a visible-field diff for these files. No original
configuration content is stored, downloaded or rendered.

`CONFIG_SNAPSHOT_KEY_FILE` must name a private regular file containing at least
32 bytes. The internal raw-content fingerprint is HMAC-SHA256. It and the key
version never enter JSON responses, audit metadata or frontend caches. Only the
safe projection has a public SHA-256 digest. A missing/rejected key disables
capture while keeping old evidence readable. Source identity, binding, path,
format or profile changes create a new generation; fingerprint-key changes also
make old comparisons incompatible rather than creating false drift.

## Storage and concurrency

All writes use the existing Ops database handle and these new collections:

- `app_config_sources`: source metadata, management revision, latest references,
  baseline reference, bounded evidence summaries and a short source lease.
- `app_config_snapshots`: immutable safe projections or metadata-only versions,
  internal fingerprints, identity context and collection time.
- `app_config_observations`: successful, failed and unchanged collection attempts.

Times in these new collections are BSON dates. Existing collections are not
migrated. GETs do not initialise indexes, collect files or repair storage.
The explicit `backend/cmd/config-snapshots-init` CLI defaults to dry-run and
creates only source/time indexes when `--apply` is supplied.

Source leases and version-conditional updates serialize capture, baseline and
retention mutations. A durable publication journal permits an interrupted
multi-document publication to finish on a later authorized mutation or worker
maintenance pass. A pending publication is visible separately; a GET does not
silently repair it. UUID request IDs provide idempotency. An identical retry does
not refresh its observation time. Unchanged content reuses the preceding content
version while adding an attempt record. A-to-B-to-A changes remain observations,
not overwrites of the prior content.

Baseline updates require `expectedRevision` and an explicit snapshot ID, or an
empty string to clear. Cross-source, incompatible and unavailable versions are
rejected. The first capture never becomes a baseline automatically. The last
successful snapshot is retained separately from the last failed attempt.

## Comparison, schedule and retention

Comparison distinguishes no baseline, incompatible evidence, no observed change,
visible-field change, unshown-content change and unavailable evidence. Raw changes
with identical projections are not described as definitely being secret changes.
Sequence comparison preserves insertions/deletions and is bounded by line, cell
and time budgets. Metadata-only or over-budget comparison never returns an empty
successful diff. Display is plain text.

Fixed per-source intervals are optional, server-declared and disabled by default.
The supported range is 60 to 86400 seconds; there is no general scheduler, Shell
or command queue. Due time and the current worker's schedule outcome are exposed
separately from persisted observations. Restart does not backfill an unlimited
queue. All capture paths share a maximum of two concurrent operations and one
lease per source, with a five-second context budget.

Ordinary attempts expire after 90 days. Ordinary versions are limited to 90 days
and 100 per source, while the current baseline and latest successful version are
protected. Retention uses the same source lease; snapshots have no blanket TTL.
The initial capacity guard is 1 GiB of snapshot data and 256 MiB of observations,
with headroom reserved for concurrent bounded captures. Exhaustion refuses new
capture instead of deleting protected evidence. Retained source history remains
readable after removal from the active declaration.

## API

All nine operations are registered by Go under `/api/config-snapshots`:

| Method | Suffix | Meaning |
| --- | --- | --- |
| GET | `/meta` | Bounds, capabilities and readiness |
| GET | `/sources` | Filtered catalogue/history with collection-wide summaries |
| GET | `/sources/{sourceId}` | Source and recent evidence |
| POST | `/sources/{sourceId}/captures` | Idempotent governed collection |
| GET | `/sources/{sourceId}/observations` | Cursor-paginated attempts |
| GET | `/sources/{sourceId}/snapshots` | Cursor-paginated content versions |
| GET | `/sources/{sourceId}/snapshots/{snapshotId}` | Safe content or metadata |
| GET | `/sources/{sourceId}/diff` | Bounded left/right comparison |
| PUT | `/sources/{sourceId}/baseline` | Revision-protected reference update |

Source references are resolved in bounded Inventory batches for listings. Page
counts never replace whole-filter summaries. Failed storage/catalogue reads keep
summary counts unavailable. Historical and current source scopes are labelled.

## Limits

This is an observation feature, not restorable backup, configuration distribution,
remote execution or proof of service health. Remote Agent configuration collection
is not implemented. It needs a separate locally declared source capability,
machine protocol and real two-host TLS acceptance while retaining existing Agent
compatibility. Operator/network/PLMN metadata is not tenant isolation.
