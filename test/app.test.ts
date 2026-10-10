import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { app, downloadRange } from "../src/index";
import {
  MAX_FILE_SIZE,
  PART_SIZE,
  RETENTION_SECONDS,
  UPLOAD_SECONDS,
  codeSchema,
  displayCode,
  uploadSchema,
} from "../src/shared";
import {
  cleanup,
  createTransfer,
  getFile,
  now,
  objectKey,
  removeFile,
} from "../src/store";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
  }
}

const origin = "https://files.example.com";
const bindings: Env = { ...env, ACCESS_AUD: "test-audience" };
let counter = 0;
let signingKey: CryptoKey;

async function token(
  email = "staff@sensmore.ai",
  overrides: { aud?: string; iss?: string; exp?: number } = {},
): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("staff-id")
    .setAudience(overrides.aud ?? bindings.ACCESS_AUD)
    .setIssuer(overrides.iss ?? `https://${bindings.ACCESS_TEAM_DOMAIN}`)
    .setExpirationTime(overrides.exp ?? now() + 3600)
    .sign(signingKey);
}

async function call(
  path: string,
  init: RequestInit = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", origin);
  headers.set("CF-Connecting-IP", `test-${++counter}`);
  return app.request(
    `${origin}${path}`,
    { ...init, headers },
    { ...bindings, ...overrides },
  );
}

async function start(
  code: string,
  size: number,
  name = "test.bin",
  fingerprint = crypto.randomUUID().replaceAll("-", "").repeat(2),
) {
  const response = await call(`/upload/${code}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, size, fingerprint }),
  });
  expect(response.status).toBeLessThan(300);
  return uploadSchema.parse(await response.json());
}

async function part(
  code: string,
  id: string,
  number: number,
  data: Uint8Array<ArrayBuffer>,
) {
  return call(`/upload/${code}/${id}/${number}`, {
    method: "PUT",
    headers: { "Content-Length": String(data.byteLength) },
    body: data,
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(String(input)).toBe(
      `https://${bindings.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
    );
    return Response.json({ keys: [jwk] });
  });
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM transfers").run();
});

describe("staff authentication and public links", () => {
  it("keeps staff routes closed without Access, including forged email headers", async () => {
    expect((await call("/admin", {}, { ACCESS_AUD: "" })).status).toBe(503);
    expect(
      (
        await call("/admin", {
          headers: {
            "Cf-Access-Authenticated-User-Email": "staff@sensmore.ai",
          },
        })
      ).status,
    ).toBe(401);
    for (const jwt of [
      await token("outsider@gmail.com"),
      await token(undefined, { aud: "other-app" }),
      await token(undefined, { iss: "https://other.cloudflareaccess.com" }),
      await token(undefined, { exp: now() - 60 }),
      "forged",
    ]) {
      expect(
        (await call("/admin", { headers: { "Cf-Access-Jwt-Assertion": jwt } }))
          .status,
      ).toBe(403);
    }
  });

  it("creates a pronounceable public link with verified staff auth and enforces ownership", async () => {
    const response = await call("/admin/generate", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": await token() },
    });
    expect(response.status).toBe(201);
    const result = await response.json<{ code: string; url: string }>();
    expect(result.code).toMatch(/^\d{3}(-\d{3}){4}$/);
    expect((await call(result.url)).status).toBe(200);
    expect(
      (
        await call(`/admin/deactivate/${result.code}`, {
          method: "POST",
          headers: {
            "Cf-Access-Jwt-Assertion": await token("other@sensmore.ai"),
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(`/admin/deactivate/${result.code}`, {
          method: "POST",
          headers: { "Cf-Access-Jwt-Assertion": await token() },
        })
      ).status,
    ).toBe(200);
    expect((await call(result.url)).status).toBe(410);
  });

  it("rejects cross-site changes and bounds malformed input", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    expect(
      (
        await call(`/upload/${transfer.code}`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/upload/${transfer.code}`, {
          method: "POST",
          body: "not json",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/upload/${transfer.code}`, {
          method: "POST",
          body: JSON.stringify({
            name: "../oops",
            size: 1,
            fingerprint: "a".repeat(64),
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/upload/${transfer.code}`, {
          method: "POST",
          body: JSON.stringify({
            name: "test",
            size: MAX_FILE_SIZE + 1,
            fingerprint: "a".repeat(64),
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/upload/${transfer.code}`, {
          method: "POST",
          body: "x".repeat(5000),
        })
      ).status,
    ).toBe(413);
  });
});

describe("multipart uploads and downloads", () => {
  it("resumes stored parts, completes idempotently and streams range downloads", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    const fingerprint = "b".repeat(64);
    const upload = await start(
      transfer.code,
      PART_SIZE + 3,
      "<report>.bin",
      fingerprint,
    );
    const chunk = new Uint8Array(PART_SIZE).fill(7);
    expect((await part(transfer.code, upload.id, 1, chunk)).status).toBe(200);
    expect(
      (
        await call(`/upload/${transfer.code}/${upload.id}/complete`, {
          method: "POST",
        })
      ).status,
    ).toBe(409);
    const resumed = await start(
      transfer.code,
      PART_SIZE + 3,
      "<report>.bin",
      fingerprint,
    );
    expect(resumed.id).toBe(upload.id);
    expect(resumed.parts).toEqual([1]);
    expect(
      (await part(transfer.code, upload.id, 2, new Uint8Array([8, 9, 10])))
        .status,
    ).toBe(200);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await call(`/upload/${transfer.code}/${upload.id}/complete`, {
            method: "POST",
          })
        ).status,
      ).toBe(200);
    const page = await call(`/t/${displayCode(transfer.code)}`);
    expect(await page.text()).toContain("&lt;report&gt;.bin");
    const url = `/download/${transfer.code}/${upload.id}/report.bin`;
    const head = await call(url, { method: "HEAD" });
    expect(head.headers.get("Content-Length")).toBe(String(PART_SIZE + 3));
    const response = await call(url, {
      headers: { Range: `bytes=${PART_SIZE}-` },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${PART_SIZE}-${PART_SIZE + 2}/${PART_SIZE + 3}`,
    );
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      8, 9, 10,
    ]);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(
      (await call(url, { headers: { Range: `bytes=${PART_SIZE + 3}-` } }))
        .status,
    ).toBe(416);
    const suffix = await call(url, { headers: { Range: "bytes=-2" } });
    expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([9, 10]);
  });

  it("accepts the exact 100 GB boundary, limits part size, and isolates links", async () => {
    const first = await createTransfer(env.DB, "staff@sensmore.ai");
    const second = await createTransfer(env.DB, "other@sensmore.ai");
    const upload = await start(first.code, MAX_FILE_SIZE);
    expect(Math.ceil(MAX_FILE_SIZE / upload.partSize)).toBeLessThan(10000);
    expect(upload.partSize).toBeLessThan(100_000_000);
    expect(
      (await part(first.code, upload.id, 1, new Uint8Array(1))).status,
    ).toBe(400);
    expect(
      (await part(first.code, upload.id, 10000, new Uint8Array(1))).status,
    ).toBe(400);
    expect((await call(`/upload/${second.code}/${upload.id}`)).status).toBe(
      404,
    );
    expect((await call(`/upload/000000000000000/${upload.id}`)).status).toBe(
      404,
    );
    expect(
      (await call(`/upload/${first.code}/${upload.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await call(`/upload/${first.code}/${upload.id}`)).status).toBe(404);
  });

  it("handles empty files and concurrent initialization without duplicate metadata", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    const fingerprint = "c".repeat(64);
    const uploads = await Promise.all([
      start(transfer.code, 0, "empty.txt", fingerprint),
      start(transfer.code, 0, "empty.txt", fingerprint),
    ]);
    expect(uploads[0]?.id).toBe(uploads[1]?.id);
    expect(uploads[0]?.status).toBe("complete");
    const response = await call(
      `/download/${transfer.code}/${uploads[0]?.id}/empty.txt`,
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS total FROM files").first<{
          total: number;
        }>()
      )?.total,
    ).toBe(1);
  });

  it("recovers when R2 completed but the database update was interrupted", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    const upload = await start(transfer.code, 3);
    expect(
      (await part(transfer.code, upload.id, 1, new Uint8Array([1, 2, 3])))
        .status,
    ).toBe(200);
    const file = await getFile(env.DB, transfer.code, upload.id);
    const saved = await env.DB.prepare(
      "SELECT part_number, etag FROM parts WHERE file_id = ?",
    )
      .bind(file.id)
      .all<{ part_number: number; etag: string }>();
    if (!file.upload_id) throw new Error("Missing upload ID");
    await env.FILES.resumeMultipartUpload(
      objectKey(file),
      file.upload_id,
    ).complete(
      saved.results.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
    );
    expect(
      (
        await call(`/upload/${transfer.code}/${upload.id}/complete`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });
});

describe("expiry and cleanup", () => {
  it("cleans up uploads already removed by R2 lifecycle but retries other R2 failures", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    const upload = await start(transfer.code, 10);
    const file = await getFile(env.DB, transfer.code, upload.id);
    if (!file.upload_id) throw new Error("Missing upload ID");
    const multipart = env.FILES.resumeMultipartUpload(
      objectKey(file),
      file.upload_id,
    );
    await multipart.abort();
    const abort = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error("R2 abortMultipartUpload: unavailable (10001)"),
      )
      .mockRejectedValueOnce(
        new Error("R2 abortMultipartUpload: upload does not exist (10024)"),
      );
    const resume = vi
      .spyOn(env.FILES, "resumeMultipartUpload")
      .mockReturnValue({
        key: multipart.key,
        uploadId: multipart.uploadId,
        abort,
        uploadPart: multipart.uploadPart.bind(multipart),
        complete: multipart.complete.bind(multipart),
      });
    try {
      await expect(removeFile(bindings, file)).rejects.toThrow("10001");
      expect(
        await env.DB.prepare("SELECT status FROM files WHERE id = ?")
          .bind(file.id)
          .first("status"),
      ).toBe("deleting");
      await removeFile(bindings, file);
      expect(
        await env.DB.prepare("SELECT id FROM files WHERE id = ?")
          .bind(file.id)
          .first(),
      ).toBeNull();
    } finally {
      resume.mockRestore();
    }
  });

  it("expires links after 30 days and deletes completed plus unfinished uploads", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    expect(transfer.expires_at - transfer.created_at).toBe(RETENTION_SECONDS);
    const completed = await start(transfer.code, 0);
    const unfinished = await start(transfer.code, 10);
    const file = await getFile(env.DB, transfer.code, completed.id);
    expect(await env.FILES.head(objectKey(file))).not.toBeNull();
    await env.DB.prepare("UPDATE transfers SET expires_at = ? WHERE code = ?")
      .bind(now() - 1, transfer.code)
      .run();
    expect((await call(`/t/${transfer.code}`)).status).toBe(410);
    expect(
      (await part(transfer.code, unfinished.id, 1, new Uint8Array(10))).status,
    ).toBe(410);
    await cleanup(bindings);
    expect(await env.FILES.head(objectKey(file))).toBeNull();
    expect(
      await env.DB.prepare("SELECT * FROM files LIMIT 1").first(),
    ).toBeNull();
    await cleanup(bindings);
  });

  it("restarts stale uploads and validates code normalization and ranges", async () => {
    const transfer = await createTransfer(env.DB, "staff@sensmore.ai");
    const fingerprint = "d".repeat(64);
    const first = await start(transfer.code, 10, "stale.bin", fingerprint);
    await env.DB.prepare("UPDATE files SET created_at = ? WHERE id = ?")
      .bind(now() - UPLOAD_SECONDS - 1, first.id)
      .run();
    const second = await start(transfer.code, 10, "stale.bin", fingerprint);
    expect(second.id).not.toBe(first.id);
    expect(codeSchema.parse("123 456-789 012-345")).toBe("123456789012345");
    expect(downloadRange("bytes=0-999", 10)).toEqual({ offset: 0, length: 10 });
    for (const range of [
      "bytes=-0",
      "bytes=10-",
      "bytes=5-3",
      "bytes=0-1,3-4",
      "oops",
    ])
      expect(() => downloadRange(range, 10)).toThrow();
  });
});
