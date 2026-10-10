# FileDrop — Sensmore fork

Simple temporary file upload and download on Cloudflare Workers, R2 and D1.
Forked from [nathanoldfield/FileDrop](https://github.com/nathanoldfield/FileDrop), retaining its MIT license and public transfer flow. This fork uses strict TypeScript and Hono, with multipart uploads for large files.

Live: **https://files.sensmore.workers.dev** · [Staff sign-in](https://files.sensmore.workers.dev/admin)

- Staff sign in through Cloudflare Access to create and deactivate transfers. Sensmore currently uses email codes restricted to `@sensmore.ai`; Google can be enabled later in Access.
- Customers open the shared link, or enter a **15-digit code**, spoken in five groups of three: `123-456-789-012-345`. Spaces and hyphens are optional.
- Anyone with a transfer link can **upload and download all its files** without an account. Treat the code like a password.
- Up to **100 GB per file** (100,000,000,000 bytes), with three parallel 32 MiB parts. No application-wide storage or file-count quota; Cloudflare billing and service limits still apply.
- Links and their files expire **30 days after the link was created**. The displayed expiry applies to later uploads too. Deactivation blocks access immediately; an hourly job deletes the stored files.
- Interrupted uploads can resume by selecting the same, unchanged file within **7 days of starting the upload**, while its link remains active.
- Downloads stream directly to disk through the browser and support byte ranges. No previews, ZIP generation or external frontend services.

## Development

Requires Bun and pre-commit.

```sh
bun install --frozen-lockfile
bun run types
bun run build
bun run typecheck
bun run test
pre-commit run --all-files
bun run dev
```

Worker bindings are generated from `wrangler.jsonc`; `worker-configuration.d.ts` and the browser bundle are generated and ignored. Both Worker and browser source use strict TypeScript with unchecked-index and exact-optional checks. The formatter and type checker are registered in pre-commit.

Access does not run locally, and there is deliberately no development authentication bypass. Integration tests use locally signed JWTs with mocked public signing keys and local Workers/R2/D1 bindings. They cover staff authentication, ownership, multipart resume/completion, range downloads, validation, expiry and cleanup. Accepting 100 GB metadata in a test is not proof of an end-to-end 100 GB transfer.

See [deployment](docs/DEPLOYMENT.md) for provisioning and adding Google login, and [architecture](docs/ARCHITECTURE.md) for the routes and data flow.
