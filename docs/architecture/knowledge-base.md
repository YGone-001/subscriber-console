# Knowledge Base

Fault-phenomena, root-cause and resolution capture for the xCloud operations
console. This document is the authority for the knowledge base domain.

## Positioning

The knowledge base lets operators record, search and refine troubleshooting
articles. It is a native xCloud surface: it uses the Go backend, the
`xcloud_ops` database and the three-role RBAC model. Nothing is copied from the
CNMS `solutions` module beyond the concept; the implementation follows xCloud
contracts (route authority, response envelope, audit, rate limiting).

## Storage model

All metadata lives in `xcloud_ops`:

| Collection | Purpose |
|---|---|
| `app_knowledge_entries` | Article: title, protocol, phenomenon, rootCause, Markdown solution, tags, attachments, status, revision, timestamps, actor |
| `app_knowledge_files` | Attachment metadata: original name, content type, kind, size, sha256, owning entry, timestamps, actor |
| `app_knowledge_entry_versions` | Bounded content snapshots (max 20 per entry) taken before each content update; exposed read-only on the detail endpoint and restorable via `PUT` |

Attachment bytes live on the local filesystem under `KNOWLEDGE_UPLOAD_DIR`
(default `/srv/internal-resource-server/uploads`). Deleting an attachment moves
its bytes to `KNOWLEDGE_TRASH_DIR` (default `/srv/internal-resource-server/.trash`)
instead of removing them, preserving a recovery path. A file is owned by exactly
one entry; cross-entry reuse requires a fresh upload.

Indexes (see `scripts/init-mongo-indexes.mjs`):

```text
app_knowledge_entries:        {updatedAt:-1,_id:1}, {protocol:1,updatedAt:-1}, {tags:1}
app_knowledge_files:          {entryId:1,createdAt:1}, {createdAt:1}
app_knowledge_entry_versions: {entryId:1,revision:-1}
```

## API surface

Eleven Go registrations (six reads, five mutations):

| Method + Path | Purpose | Permission |
|---|---|---|
| `GET /api/knowledge/meta` | protocol enum, top tags, protocol distribution, active/recycle totals, limits | `core.read` |
| `GET /api/knowledge/tags` | full active tag dictionary with counts for filter autocomplete | `core.read` |
| `GET /api/knowledge/entries` | list/search (`q`, `protocol`, `tag`, `cursor`, `limit`, `sort`, `order`, `status`) | `core.read` |
| `GET /api/knowledge/entries/{entryId}` | entry detail with Markdown body, version metadata, bounded operations history and `operationsComplete`; `?export=1` downloads a JSON backup | `core.read` |
| `GET /api/knowledge/entries/{entryId}/versions/{versionId}` | full content of one historical snapshot | `core.read` |
| `POST /api/knowledge/entries` | create entry | `core.configure` |
| `PUT /api/knowledge/entries/{entryId}` | update entry (revision CAS); `restore:true` revives a soft-deleted entry; `restoreVersionId` reverts content to a snapshot | `core.configure` |
| `DELETE /api/knowledge/entries/{entryId}?revision=` | soft-delete entry (revision CAS); `&permanent=1` purges a deleted entry and its version history | `core.configure` |
| `POST /api/knowledge/files` | multipart attachment upload | `core.configure` |
| `GET /api/knowledge/files/{fileId}` | download; images inline, others attachment; `?download=1` forces download | `core.read` |
| `DELETE /api/knowledge/files/{fileId}` | delete an unbound upload owned by the current actor | `core.configure` |

List pagination is keyset-cursor with `_id` ascending as the tie-break. The
default order is `updatedAt` descending; `sort` accepts the closed set
`updatedAt|createdAt|title|protocol` and `order` accepts `asc|desc` (timestamps
default descending, text fields ascending; an explicit order always wins).
Invalid sort/order returns 400 `INVALID_QUERY_PARAMETER`. The cursor binds the
active sort field and direction, so reusing it under a different ordering is
rejected; legacy `updatedAt`-only cursors remain valid for the default sort. The
list projection omits the Markdown body and adds a computed `attachmentCount`;
the detail endpoint is the only source of full entry content. Entry detail
projects bounded `versions[]` metadata only (`versionId`, `revision`,
`createdAt`, `createdBy`); `GET /api/knowledge/entries/{entryId}/versions/{versionId}`
returns one full snapshot on demand. Entry detail also projects at most 20
entry-lifecycle audit operations (`operations`) plus attachment attach/detach
events, and always reports `operationsComplete`; an unavailable audit read sets
it to false instead of claiming no history. Unbound uploads have no entry context
and therefore never appear in entry history. The search needle is trimmed, bounded to 64 characters and
`regexp.QuoteMeta`-escaped before a case-insensitive match against title,
phenomenon, rootCause, solution, tags and protocol. The `tag` filter is an
anchored, case-insensitive exact match. No text index is created. The meta
aggregates are reused from a 30s in-process cache (failures are never cached);
the list `total` is always computed fresh from the filtered set.

## Security model

- Writes require `core.configure` plus a fresh-actor revalidation
  (`governance.RevalidateFreshActor`) against `app_users` on every mutation; a
  disabled, locked, re-roled or session-revoked account is refused even with a
  valid token, and an unavailable account store fails closed (503). Reads
  require `core.read`. The viewer role sees a read-only surface and is rejected
  403 on every mutation.
- Writes are rate-limited per user (MongoDB fixed window): create 20/60s, update
  30/60s, delete 20/60s, upload 20/60s; reads 120/60s. Exceeding a budget returns
  429 with `Retry-After`.
- Create/update use strict JSON decoding with unknown-field rejection and a
  512 KiB body cap. Update and delete carry a revision and fail with
  `KNOWLEDGE_REVISION_CONFLICT` on mismatch. A solution that references an
  inline attachment image absent from the claimed attachment set is rejected, so
  inline images and attachments stay consistent and cannot break after janitor
  cleanup.
- Attachments are double-validated by declared extension and detected magic
  bytes. Empty files are rejected. Allowed classes: PNG/JPEG/GIF/WebP, PDF,
  TXT/LOG, PCAP/PCAPNG. SVG, HTML, JavaScript and executables are rejected.
  Per-file cap 8 MiB, per-entry cap 10 explicit attachments. Inline Markdown
  images are attachments and count against the same per-entry cap; the meta
  `maxInlineImages` field equals `maxAttachments`.
- An unbound upload is private to its uploader until an entry claims it; bound
  attachments follow the owning entry's `core.read` visibility (including the
  recycle bin). The upload owner can delete an unbound upload immediately
  through `DELETE /api/knowledge/files/{fileId}`; a bound file is released via
  the entry update lifecycle.
- Attachment bytes are stored under a canonical UUID filename; client-supplied
  names are never used in paths, so path traversal is impossible. Download
  responses set `X-Content-Type-Options: nosniff`, an explicit content type,
  `ETag`, `Cache-Control: private`; non-image content is forced to
  `Content-Disposition: attachment`.
- The Markdown renderer does not enable raw HTML; link targets are restricted
  to http(s)/mailto/in-site paths, and images render only for
  `/api/knowledge/files/{uuid}`. External images are not rendered.
- Audit (best-effort) records `knowledge.entry.create/update/delete/restore/purge`,
  `knowledge.file.upload/delete` and `knowledge.denied` with bounded entry
  metadata (id, title, protocol, status, revision, attachment count, tags) and
  never the article body.

## Attachment lifecycle

1. Upload writes the bytes and a metadata record with an empty `entryId`.
2. An unbound upload can be deleted by its uploader through
   `DELETE /api/knowledge/files/{fileId}`; the bytes move to trash and the
   metadata record is released immediately.
3. Entry save atomically claims the referenced files; a file already owned by
   another entry returns `KNOWLEDGE_FILE_NOT_AVAILABLE`.
4. Update reconciles the attachment set: kept files stay bound, removed files
   are trashed, newly referenced files are claimed. If the update loses its
   revision CAS after new files were claimed, those claims are rolled back so
   the files return to the unbound pool.
5. Delete trashes and releases every bound file.
6. A background janitor (hourly, bounded) reclaims unbound uploads older than
   24 hours and orphan files whose entry no longer exists.
7. Trashed bytes are physically purged after `KNOWLEDGE_TRASH_RETENTION_DAYS`
   (default 30, `0` disables cleanup). Trash time is stamped on deletion, so the
   recovery window measures from deletion rather than upload.

## Entry lifecycle

Entries carry a `status` (`active` or `deleted`); legacy documents without a
status are treated as active. `DELETE` is a soft-delete: it sets
`status=deleted` and `deletedAt` under revision CAS and retains the document and
its attachments for recovery. The list defaults to `status=active`;
`status=deleted` is the recycle bin and `status=all` spans both. A deleted entry
remains readable via the detail endpoint. `PUT` with `restore:true` (and the
current revision) flips it back to active. `DELETE?permanent=1` purges a deleted
entry permanently, releasing its attachments to trash and deleting its version
history; an active entry must be soft-deleted first. Meta aggregates (total, top
tags, protocol distribution) count active entries only; `deletedTotal` reports
the recycle-bin count. The meta cache is invalidated after every successful
create/update/delete/restore so the next read does not wait for the 30s TTL.

The detail endpoint also projects a bounded read-only `referencedBy` list and
`referenceCount` of investigations whose `knowledgeIds` cite the entry, linking
knowledge back to the operational records that reference it (the forward
investigation-to-knowledge link already exists in the investigation editor). This
is a cross-domain read-only projection; it never writes investigations.

## Frontend

Four SPA routes in the platform group: `/knowledge`, `/knowledge/new`,
`/knowledge/:entryId`, `/knowledge/:entryId/edit`. The list page uses explicit
active/recycle tabs with independent counts, submit-triggered search (Enter or
the search button) with match highlighting and a coarse match-location hint for
tag/protocol/body hits, protocol and free-text tag filters with dictionary autocomplete, sort/order controls,
a list/table view switch, and cursor paging whose back-stack is carried in the URL (`cursor` + `stack`) so
refresh, back/forward navigation and shared links keep the page depth. The list
supports page-local multi-select with batch export, batch delete/permanent
delete, batch restore and batch tag merge; batch writes reuse the single-entry
endpoints through a bounded concurrency runner and report partial failures. Batch
tag merges fetch each entry, merge tags case-insensitively, skip unchanged rows
and update only the rows that actually change. The recycle-bin view
has its own KPI, empty state and deleted-row marker, and an error state offers
retry. The detail page renders the phenomenon, root cause and
resolution as Markdown, with attachment image/PDF/text preview, version
metadata, explicit restore confirmation and success feedback; delete
confirmations include reference and attachment impact. Version history supports
on-demand preview and a bounded line diff against the current entry, alongside
the restore action. Attachments open in a unified viewer (image zoom, PDF,
text) with a download action. The detail page shows bounded operation history,
copy-link and print actions. The editor offers a
Markdown toolbar (headings 1-3, bold/italic/strikethrough, inline code, ordered/
unordered/task lists, quote, link, code block, table, horizontal rule, plus
Ctrl+B/I/K shortcuts), Ctrl/Cmd+S save, preview, multi-file and drag/drop
attachment upload, inline image paste/drop, explicit unsaved-draft
restore/discard, character counts, field-level labels and revision-conflict
handling with copy-my-changes and reload-latest actions. New-entry drafts are
stored in sessionStorage so tabs editing different entries do not overwrite each
other; empty forms never create a draft. Saving preserves the originating list
URL (`returnTo`) so filters and paging survive. `viewer` hides all mutation entry
points, and the backend remains the authorization authority.

## Performance and scale triggers

These are recorded `PERFORMANCE_FINDING` trigger lines (AGENTS.md §8.3), not
current defects. No premature optimization or read-path index is added before a
trigger is reached; business index changes go through `npm run mongo:indexes`.

- **Search ranking / text index**: list search is a `regexp.QuoteMeta`-escaped
  `$or` regex across six fields with no text index, ordered by the active sort
  rather than relevance. Trigger: more than ~5000 active entries, or list p95
  above ~200ms. Action then: evaluate a text index and relevance ranking.
- **Version projection**: entry detail returns bounded version metadata only;
  snapshot bodies are fetched on demand. This keeps the detail response size
  independent of the number of retained versions (up to 20 × 200KB previously).
- **Meta aggregates**: served from a 30s in-process cache and invalidated on
  every successful entry mutation; the list `total` is computed fresh. No
  further action unless aggregation latency grows.
- **Attachment deduplication**: SHA256 is computed but not used to deduplicate;
  identical uploads store separate copies. Trigger: attachment storage growth
  warrants content-addressed dedup. Action then: reference-counted dedup.
- **Streaming upload**: uploads read up to 8 MiB into memory before writing.
  Trigger: concurrent-upload memory pressure observed in production. Action then:
  stream to disk.
- **View count**: a per-entry view counter (write-on-read) is intentionally not
  implemented; `referenceCount` from citing investigations is the current usage
  signal. Revisit only if operational analytics require view tracking.
