# Deploying FileDrop

Use a dedicated R2 bucket and D1 database. This fork does not migrate an existing upstream KV deployment. Cloudflare storage, operations, Workers, D1 and Access usage remain subject to the account's plan and billing; large file transfers are not promised to be free.

## Install and configure

```sh
bun install --frozen-lockfile
bun x wrangler login
cp wrangler.jsonc wrangler.deploy.jsonc
bun x wrangler r2 bucket create sensmore-filedrop --location weur
bun x wrangler d1 create sensmore-filedrop --location weur
```

Set `account_id` and the returned `database_id` in the ignored `wrangler.deploy.jsonc`. Set the Worker name, bucket/database names, Access team domain and allowed email domain for your account. The Worker name `files` in the `sensmore` Workers account gives `files.sensmore.workers.dev`. Keep preview URLs disabled and the R2 bucket private.

Apply the database schema and storage lifecycle:

```sh
bun x wrangler d1 migrations apply sensmore-filedrop --remote --config wrangler.deploy.jsonc
bun x wrangler r2 bucket lifecycle set sensmore-filedrop --file r2-lifecycle.json --force
```

The lifecycle command replaces rules on this dedicated bucket: completed objects under `transfers/` expire after 30 days; incomplete multipart uploads abort after 7 days. The hourly Worker job additionally applies each transfer's earlier expiration or deactivation.

## Staff authentication

In Cloudflare Zero Trust, create a **self-hosted Access application**:

- Domain/path: `files.sensmore.workers.dev/admin` (the `/admin` path and its descendants only).
- Session: 24 hours.
- Allow policy: **Emails ending in** `sensmore.ai`.
- Login method for now: **One-time PIN** (email codes).
- Do not add Everyone/Bypass policies or protect the whole hostname: customers need the public transfer paths.

Copy the application's **AUD tag** into `vars.ACCESS_AUD` in `wrangler.deploy.jsonc`. Set `ACCESS_TEAM_DOMAIN` to `sensmore.cloudflareaccess.com` and `ALLOWED_EMAIL_DOMAIN` to `sensmore.ai`.

The Worker verifies the Access JWT itself, including audience and issuer. An empty audience disables staff access. An email header by itself is never sufficient.

### Adding Google later

Create an internal Google Workspace OAuth app and add it as a Google identity provider in Cloudflare Zero Trust. Use the redirect URL shown by Cloudflare. Enable that provider for **FileDrop staff**, keeping the `sensmore.ai` allow policy and the same Access application/AUD. Remove the One-time PIN method from this application if Google should be the only login method. No Worker code or shared custom authentication service is needed. Other apps can use the same identity provider with their own Access applications and policies.

## Validate and publish

```sh
bun run types
bun run build
bun run typecheck
bun run test
pre-commit run --all-files
bun x wrangler deploy --config wrangler.deploy.jsonc
```

The committed `wrangler.jsonc` is the portable local/test template. Always pass `--config wrangler.deploy.jsonc` for this deployment; it contains the actual D1 ID and Access AUD.

Check the deployment:

1. `/` loads without authentication and accepts grouped or ungrouped transfer codes.
2. `/admin` redirects an anonymous browser to Access; only a `@sensmore.ai` user can sign in.
3. Create a transfer, open it in a separate unauthenticated browser, upload a file, then download and compare its bytes.
4. Pause a multipart upload and select the same file again: previously completed parts should be retained.
5. Deactivate the transfer from its owner's dashboard; public access stops immediately.
6. Check the hourly scheduled execution and R2 lifecycle rules. Check storage usage and failed cleanup events if physical deletion falls behind.

Unit/integration tests exercise local R2/D1 and signed test JWTs; they do not prove a production Google/OTP login or a complete 100 GB transfer. No authentication bypass should be added for local development or smoke tests.

## Operations

- Change allowed staff or login providers in the FileDrop Access application.
- D1 contains transfer/file/part metadata; R2 contains the bytes. Do not delete metadata alone when removing files: the cleanup job needs it to locate objects.
- Revoking a link immediately blocks new requests; running downloads may finish.
- Re-deploy with the same ignored config after building and checks.
- Keep the lifecycle policy in place as a backstop for orphaned objects and unfinished uploads.
- Failures log event types/counts without URLs, codes or file names. Avoid recording live transfer URLs in screenshots, support tickets or Worker tails.
