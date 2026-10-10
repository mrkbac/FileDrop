import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { staffOnly, sameOrigin, limitLinks } from "./auth";
import type { AppEnv } from "./auth";
import { codeSchema, displayCode } from "./shared";
import {
  cleanup,
  createTransfer,
  getFile,
  getTransfer,
  now,
  objectKey,
} from "./store";
import type { FileRow } from "./store";
import { uploads } from "./uploads";
import {
  dashboardPage,
  homePage,
  transferPage,
  unavailablePage,
} from "./views";
import type { TransferSummary } from "./views";

export const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  c.header("Strict-Transport-Security", "max-age=31536000");
});
app.use("*", sameOrigin);
app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/", (c) => c.html(homePage()));

const admin = new Hono<AppEnv>();
admin.use("*", staffOnly);
admin.get("/", async (c) => {
  const links = await c.env.DB.prepare(
    `SELECT t.*, COUNT(f.id) AS file_count, COALESCE(SUM(f.size), 0) AS total_size
    FROM transfers t LEFT JOIN files f ON f.transfer_code = t.code AND f.status = 'complete'
    WHERE t.owner = ? AND t.active = 1 AND t.expires_at > ? GROUP BY t.code ORDER BY t.created_at DESC`,
  )
    .bind(c.get("email"), now())
    .all<TransferSummary>();
  return c.html(dashboardPage(c.get("email"), links.results));
});
admin.post("/generate", limitLinks, async (c) => {
  const transfer = await createTransfer(c.env.DB, c.get("email"));
  return c.json(
    {
      code: displayCode(transfer.code),
      url: `/t/${displayCode(transfer.code)}`,
    },
    201,
  );
});
admin.post("/deactivate/:code", async (c) => {
  const code = codeSchema.safeParse(c.req.param("code"));
  if (!code.success)
    throw new HTTPException(404, { message: "Transfer not found." });
  const result = await c.env.DB.prepare(
    "UPDATE transfers SET active = 0 WHERE code = ? AND owner = ?",
  )
    .bind(code.data, c.get("email"))
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Transfer not found." });
  return c.json({ ok: true });
});
app.route("/admin", admin);
app.get("/t/:code", limitLinks, async (c) => {
  try {
    const transfer = await getTransfer(c.env.DB, c.req.param("code"));
    const files = await c.env.DB.prepare(
      "SELECT * FROM files WHERE transfer_code = ? AND status = 'complete' ORDER BY created_at",
    )
      .bind(transfer.code)
      .all<FileRow>();
    return c.html(transferPage(transfer, files.results));
  } catch (error) {
    if (error instanceof HTTPException && error.status === 410)
      return c.html(unavailablePage(), 410);
    throw error;
  }
});
app.route("/upload", uploads);

export function downloadRange(
  value: string,
  size: number,
): { offset: number; length: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new HTTPException(416);
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    throw new HTTPException(416);
  return { offset: start, length: end - start + 1 };
}

app.on(
  ["GET", "HEAD"],
  "/download/:code/:id/:filename",
  limitLinks,
  async (c) => {
    const transfer = await getTransfer(c.env.DB, c.req.param("code"));
    const file = await getFile(c.env.DB, transfer.code, c.req.param("id"));
    if (file.status !== "complete")
      throw new HTTPException(404, { message: "File is not ready." });
    const head = await c.env.FILES.head(objectKey(file));
    if (!head)
      throw new HTTPException(404, { message: "File is no longer available." });
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(head.size),
      "Content-Disposition": `attachment; filename="${file.name.replace(/[^a-zA-Z0-9._ -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (s) => `%${s.charCodeAt(0).toString(16)}`)}`,
      "Accept-Ranges": "bytes",
      ETag: head.httpEtag,
      "Last-Modified": head.uploaded.toUTCString(),
    });
    if (c.req.method === "HEAD") return new Response(null, { headers });
    const rangeHeader = c.req.header("Range");
    const ifRange = c.req.header("If-Range");
    let range: { offset: number; length: number } | undefined;
    if (
      rangeHeader &&
      (!ifRange ||
        ifRange === head.httpEtag ||
        ifRange === head.uploaded.toUTCString())
    ) {
      try {
        range = downloadRange(rangeHeader, head.size);
      } catch {
        headers.set("Content-Range", `bytes */${head.size}`);
        headers.delete("Content-Length");
        return new Response(null, { status: 416, headers });
      }
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
      );
      headers.set("Content-Length", String(range.length));
    }
    const object = await c.env.FILES.get(
      objectKey(file),
      range ? { range } : {},
    );
    if (!object)
      throw new HTTPException(404, { message: "File is no longer available." });
    return new Response(object.body, { status: range ? 206 : 200, headers });
  },
);

app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message || "Request failed." }, error.status);
  if (error instanceof SyntaxError)
    return c.json({ error: "Invalid request body." }, 400);
  // Transfer codes are credentials: do not log URLs, filenames, bodies, or exception messages.
  console.error(JSON.stringify({ event: "request_failed", type: error.name }));
  return c.json({ error: "Request failed. Please retry." }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
  },
} satisfies ExportedHandler<Env>;
