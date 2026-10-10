# Architecture

The browser uploads slices of each file to a Hono Worker. The Worker streams each request into an R2 multipart upload; it never buffers a whole file. D1 stores transfer ownership, expiration, file state and completed part numbers/ETags. D1 constraints keep concurrent initialization from creating duplicate file metadata.

The public UI follows the upstream FileDrop flow: open a transfer, select or drop files, upload, and download. There is no preview or file-management subsystem.

## Files

| Path                      | Responsibility                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `src/index.ts`            | Hono routes, response headers, streaming/range downloads, scheduled handler         |
| `src/auth.ts`             | Verified Cloudflare Access JWTs, domain restriction, origin checks, link rate limit |
| `src/uploads.ts`          | Multipart initialization, resume, parts, completion and cancellation                |
| `src/store.ts`            | D1 records, cryptographic transfer codes, expiry and cleanup                        |
| `src/shared.ts`           | Limits, validation schemas, shared formatting                                       |
| `src/views.ts`            | Escaped HTML pages                                                                  |
| `src/client.ts`           | Strict TypeScript browser upload client                                             |
| `public/assets/style.css` | FileDrop styling                                                                    |
| `migrations/`             | D1 schema                                                                           |
| `test/app.test.ts`        | Workers-runtime integration tests                                                   |

## Routes

| Method    | Path                            | Access                                               |
| --------- | ------------------------------- | ---------------------------------------------------- |
| GET       | `/`                             | Public code entry                                    |
| GET       | `/admin`                        | Staff dashboard; only the user's active transfers    |
| POST      | `/admin/generate`               | Staff creates a transfer                             |
| POST      | `/admin/deactivate/:code`       | Transfer owner only                                  |
| GET       | `/t/:code`                      | Bearer code; upload/download page                    |
| POST      | `/upload/:code`                 | Bearer code; initialize or resume matching file      |
| GET       | `/upload/:code/:id`             | Bearer code + file ID; saved parts                   |
| PUT       | `/upload/:code/:id/:part`       | Bearer code + file ID; stream one part               |
| POST      | `/upload/:code/:id/complete`    | Bearer code + file ID; finalize upload               |
| DELETE    | `/upload/:code/:id`             | Bearer code + file ID; cancel unfinished upload      |
| GET, HEAD | `/download/:code/:id/:filename` | Bearer code; completed file, with byte-range support |

All mutations require an exact same-origin `Origin` header. File names and numeric bounds are validated at the Worker; SQL uses bound parameters. Files are served as attachments with `nosniff`. User-supplied names are escaped in HTML and rendered as text in the client.

## Uploads and retention

Each file is capped at 100,000,000,000 bytes: at most 2,981 parts of 32 MiB. The final part can be smaller. Three browser requests run concurrently; failed network/server requests retry with backoff. Selecting an interrupted file again reuses saved parts. The resume identifier hashes the name, size, modification time, and first/last 64 KiB. It is an identity hint, not a whole-file integrity checksum: do not modify a file during or between upload attempts.

R2 keys are `transfers/<code>/<random-file-id>`. Completed files become visible only after all parts exist, R2 completion succeeds and the actual object size matches the declared size. Retrying completion recovers if R2 succeeded before the D1 update. Cleanup marks files as deleting before touching R2 so failures can be retried without exposing half-deleted files.

A transfer expires 30 days after creation, including any files added later. Expired or deactivated transfers reject new requests immediately. Streams already in progress may finish. Hourly cleanup deletes up to 200 expired/deactivated/stale files per run; a backlog or a Cloudflare failure can delay physical deletion. Independent R2 lifecycle rules expire objects 30 days after object creation and abort unfinished multipart uploads after 7 days. This also bounds orphaned storage if a Worker fails between R2 and D1 operations. Lifecycle deletion is asynchronous.

## Authentication

Only `/admin` and its descendants are protected by the Cloudflare Access application. Public transfer endpoints need no Access bypass policies because they are outside that application path. The Worker independently validates Access JWT signature, issuer, audience, expiry, subject and email domain. A forged email header alone does not authorize anything.

Transfer codes contain 15 uniformly random decimal digits (approximately 50 bits), displayed in five groups of three for dictation. Link lookup, upload initialization and downloads have a per-IP limit of 30 requests/minute; Cloudflare's Worker rate limiter is local to a Cloudflare location, not a globally exact quota. Multipart operations require both the code and the random file ID before revealing transfer state, so bulk parts are not throttled by the link lookup budget. Do not shorten the codes casually.

Anyone receiving a code can read and add files to that transfer. There is no per-recipient identity, upload-only mode, malware scanning or application-wide storage quota. Browser responses use `no-store` and `no-referrer`; request URLs and error messages containing codes are not logged by application code. Automatic Worker invocation logs are disabled because URLs contain bearer credentials. Avoid enabling request logging or tailing live customer traffic without treating those logs as sensitive.

The R2 bucket stays private. No R2 keys or account secrets are sent to the browser. The account-specific deployment config is ignored; the committed config fails closed for staff access until its Access audience is supplied.
