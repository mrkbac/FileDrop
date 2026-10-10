# Deployment verification — 10 October 2026

- Worker and browser strict TypeScript checks: passed.
- Pre-commit formatting checks: passed.
- Workers-runtime integration tests: 10 passed, using local D1/R2 and signed test Access JWTs.
- Production public entry page: HTTP 200; code entry with spaces opens the grouped transfer URL.
- Anonymous `/admin` and `/admin/generate`: redirect to Cloudflare Access, including when supplied with a forged email header.
- Production R2 lifecycle: enabled, 30-day object expiry and 7-day incomplete multipart abort.
- Production upload: 134,217,745 bytes (128 MiB plus 17 bytes), five parts; reinitializing after the first part returned the same upload and its saved part number. Remaining full parts were sent concurrently. Full-file SHA-256 and a suffix range download matched the generated source bytes. The successful run took about 59 seconds to upload and 83 seconds to download on this connection; this is not a general speed benchmark.
- The first smoke-test client lost a connection during parallel upload; the service retained parts 1–3. The production browser client already retries transient part failures. A subsequent smoke test using Node fetch and retries passed.
- Disposable test objects and transfer metadata were removed after verification.

## Not verified

A full 100 GB file was not transferred; tests validate the size boundary and multipart layout. Real staff email-login completion was left to the user by request. Google is intentionally not configured. The public page and code entry were checked in Chrome; automated browser file selection was blocked by the extension's local-file permission, so the deployed upload/download flow was exercised through HTTP rather than the browser picker. No 30-day wall-clock retention soak was performed; expiry and cleanup are covered by integration tests and the live lifecycle configuration.
