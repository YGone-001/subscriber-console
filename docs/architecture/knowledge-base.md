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
| `app_knowledge_entries` | Article: title, protocol, phenomenon, rootCause, Markdown solution, tags, attachments, revision, timestamps, actor |
| `app_knowledge_files` | Attachment metadata: original name, content type, kind, size, sha256, owning entry, timestamps, actor |

Attachment bytes live on the local filesystem under `KNOWLEDGE_UPLOAD_DIR`
(default `/srv/internal-resource-server/uploads`). Deleting an attachment moves
its bytes to `KNOWLEDGE_TRASH_DIR` (default `/srv/internal-resource-server/.trash`)
instead of removing them, preserving a recovery path. A file is owned by exactly
one entry; cross-entry reuse requires a fresh upload.

Indexes (see `scripts/init-mongo-indexes.mjs`):

```text
app_knowledge_entries: {updatedAt:-1,_id:1}, {protocol:1,updatedAt:-1}, {tags:1}
app_knowledge_files:   {entryId:1,createdAt:1}, {createdAt:1}
```

## API surface

Eight Go registrations (five reads, three mutations):

| Method + Path | Purpose | Permission |
|---|---|---|
| `GET /api/knowledge/meta` | protocol enum, top tags, protocol distribution, total, limits | `core.read` |
| `GET /api/knowledge/entries` | list/search (`q`, `protocol`, `tag`, `cursor`, `limit`, `sort`, `order`, `status`) | `core.read` |
| `GET /api/knowledge/entries/{entryId}` | entry detail with Markdown body | `core.read` |
| `POST /api/knowledge/entries` | create entry | `core.configure` |
| `PUT /api/knowledge/entries/{entryId}` | update entry (revision CAS); `restore:true` revives a soft-deleted entry | `core.configure` |
| `DELETE /api/knowledge/entries/{entryId}?revision=` | soft-delete entry (revision CAS); `&permanent=1` purges a deleted entry | `core.configure` |
| `POST /api/knowledge/files` | multipart attachment upload | `core.configure` |
| `GET /api/knowledge/files/{fileId}` | download; images inline, others attachment; `?download=1` forces download | `core.read` |

List pagination is keyset-cursor with `_id` ascending as the tie-break. The
default order is `updatedAt` descending; `sort` accepts the closed set
`updatedAt|createdAt|title|protocol` and `order` accepts `asc|desc` (timestamps
default descending, text fields ascending; an explicit order always wins).
Invalid sort/order returns 400 `INVALID_QUERY_PARAMETER`. The cursor binds the
active sort field and direction, so reusing it under a different ordering is
rejected; legacy `updatedAt`-only cursors remain valid for the default sort. The
list projection omits the Markdown body and adds a computed `attachmentCount`;
the detail endpoint is the only source of full content. The search needle is
trimmed, bounded to 64 characters and `regexp.QuoteMeta`-escaped before a
case-insensitive match against title, phenomenon, rootCause, solution, tags and
protocol. No text index is created. The meta aggregates are reused from a 30s
in-process cache (failures are never cached); the list `total` is always computed
fresh from the filtered set.

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
  bytes. Allowed classes: PNG/JPEG/GIF/WebP, PDF, TXT/LOG, PCAP/PCAPNG. SVG,
  HTML, JavaScript and executables are rejected. Per-file cap 8 MiB, per-entry
  cap 10 explicit attachments. Inline Markdown images are attachments and count
  against the same per-entry cap; the meta `maxInlineImages` field equals
  `maxAttachments`.
- Attachment bytes are stored under a canonical UUID filename; client-supplied
  names are never used in paths, so path traversal is impossible. Download
  responses set `X-Content-Type-Options: nosniff`, an explicit content type,
  `ETag`, `Cache-Control: private`; non-image content is forced to
  `Content-Disposition: attachment`.
- The Markdown renderer does not enable raw HTML; link targets are restricted
  to http(s)/mailto/in-site paths, and images render only for
  `/api/knowledge/files/{uuid}`. External images are not rendered.
- Audit (best-effort) records `knowledge.entry.create/update/delete`,
  `knowledge.file.upload` and `knowledge.denied` without the article body.

## Attachment lifecycle

1. Upload writes the bytes and a metadata record with an empty `entryId`.
2. Entry save atomically claims the referenced files; a file already owned by
   another entry returns `KNOWLEDGE_FILE_NOT_AVAILABLE`.
3. Update reconciles the attachment set: kept files stay bound, removed files
   are trashed, newly referenced files are claimed.
4. Delete trashes and releases every bound file.
5. A background janitor (hourly, bounded) reclaims unbound uploads older than
   24 hours and orphan files whose entry no longer exists.
6. Trashed bytes are physically purged after `KNOWLEDGE_TRASH_RETENTION_DAYS`
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
entry permanently, releasing its attachments to trash; an active entry must be
soft-deleted first. Meta aggregates (total, top tags, protocol distribution)
count active entries only.

## Frontend

Four SPA routes in the platform group: `/knowledge`, `/knowledge/new`,
`/knowledge/:entryId`, `/knowledge/:entryId/edit`. The list page exposes
submit-triggered search (Enter or the search button) with match highlighting,
protocol and free-text tag filters, sort/order controls and cursor paging whose
back-stack survives refresh; the detail page renders the phenomenon as text and
the root cause and resolution as Markdown, with attachment image/PDF/text
preview; the editor offers a Markdown toolbar (including code block, table and
horizontal rule, plus Ctrl+B/I/K shortcuts), preview, attachment upload,
new-entry draft autosave and revision-conflict handling. `viewer` hides all
mutation entry points, and the backend remains the authorization authority.
