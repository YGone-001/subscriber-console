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
| `GET /api/knowledge/entries` | list/search (`q`, `protocol`, `tag`, `cursor`, `limit`) | `core.read` |
| `GET /api/knowledge/entries/{entryId}` | entry detail with Markdown body | `core.read` |
| `POST /api/knowledge/entries` | create entry | `core.configure` |
| `PUT /api/knowledge/entries/{entryId}` | update entry (revision CAS) | `core.configure` |
| `DELETE /api/knowledge/entries/{entryId}?revision=` | delete entry (revision CAS) | `core.configure` |
| `POST /api/knowledge/files` | multipart attachment upload | `core.configure` |
| `GET /api/knowledge/files/{fileId}` | download; images inline, others attachment; `?download=1` forces download | `core.read` |

List pagination is keyset-cursor ordered by `updatedAt` descending then `_id`
ascending. The list projection omits the Markdown body; the detail endpoint is
the only source of full content. The search needle is trimmed, bounded to 64
characters and `regexp.QuoteMeta`-escaped before a case-insensitive match against
title, phenomenon, rootCause, tags and protocol. No text index is created.

## Security model

- Writes require a revalidated actor (`core.configure`); reads require
  `core.read`. The viewer role sees a read-only surface and is rejected 403 on
  every mutation.
- Create/update use strict JSON decoding with unknown-field rejection and a
  512 KiB body cap. Update and delete carry a revision and fail with
  `KNOWLEDGE_REVISION_CONFLICT` on mismatch.
- Attachments are double-validated by declared extension and detected magic
  bytes. Allowed classes: PNG/JPEG/GIF/WebP, PDF, TXT/LOG, PCAP/PCAPNG. SVG,
  HTML, JavaScript and executables are rejected. Per-file cap 8 MiB, per-entry
  cap 10 explicit attachments.
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

## Frontend

Four SPA routes in the platform group: `/knowledge`, `/knowledge/new`,
`/knowledge/:entryId`, `/knowledge/:entryId/edit`. The list page exposes
debounced search, protocol and top-tag filters and cursor paging; the detail
page renders phenomenon/root-cause plus the Markdown resolution with attachments
and image preview; the editor offers a Markdown toolbar with preview, attachment
upload and revision-conflict handling. `viewer` hides all mutation entry points,
and the backend remains the authorization authority.
