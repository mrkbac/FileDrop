import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "./auth";
import { limitLinks } from "./auth";
import { PART_SIZE, UPLOAD_SECONDS, codeSchema, startSchema } from "./shared";
import type { Upload } from "./shared";
import { getFile, getTransfer, now, objectKey, removeFile } from "./store";
import type { FileRow } from "./store";

async function describe(db: D1Database, file: FileRow): Promise<Upload> {
  if (file.status === "deleting")
    throw new HTTPException(410, { message: "Upload was cancelled." });
  const parts = await db
    .prepare(
      "SELECT part_number FROM parts WHERE file_id = ? ORDER BY part_number",
    )
    .bind(file.id)
    .all<{ part_number: number }>();
  return {
    id: file.id,
    status: file.status,
    partSize: PART_SIZE,
    parts: parts.results.map((p) => p.part_number),
  };
}

export const uploads = new Hono<AppEnv>();

async function getUploadFile(
  env: Env,
  code: string,
  id: string,
): Promise<FileRow> {
  const parsed = codeSchema.safeParse(code);
  // Check the random file ID first so unthrottled part requests cannot probe transfer codes.
  const file = await getFile(env.DB, parsed.success ? parsed.data : "", id);
  await getTransfer(env.DB, file.transfer_code);
  return file;
}

uploads.post("/:code", limitLinks, bodyLimit({ maxSize: 4096 }), async (c) => {
  const transfer = await getTransfer(c.env.DB, c.req.param("code"));
  const parsed = startSchema.safeParse(await c.req.json<unknown>());
  if (!parsed.success)
    throw new HTTPException(400, {
      message:
        "Invalid filename, size, or fingerprint. Maximum file size is 100 GB.",
    });
  const input = parsed.data;
  const existing = await c.env.DB.prepare(
    "SELECT * FROM files WHERE transfer_code = ? AND fingerprint = ?",
  )
    .bind(transfer.code, input.fingerprint)
    .first<FileRow>();
  if (existing) {
    if (existing.name !== input.name || existing.size !== input.size)
      throw new HTTPException(409, {
        message: "File does not match the saved upload.",
      });
    if (
      existing.status === "deleting" ||
      (existing.status === "uploading" &&
        existing.created_at + UPLOAD_SECONDS <= now())
    ) {
      await removeFile(c.env, existing);
    } else return c.json(await describe(c.env.DB, existing));
  }
  const file: FileRow = {
    id: crypto.randomUUID(),
    transfer_code: transfer.code,
    name: input.name,
    size: input.size,
    fingerprint: input.fingerprint,
    upload_id: null,
    status: input.size === 0 ? "complete" : "uploading",
    created_at: now(),
    updated_at: now(),
  };
  if (input.size === 0)
    await c.env.FILES.put(objectKey(file), new Uint8Array());
  else
    file.upload_id = (
      await c.env.FILES.createMultipartUpload(objectKey(file), {
        httpMetadata: { contentType: "application/octet-stream" },
      })
    ).uploadId;
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO files(id, transfer_code, name, size, fingerprint, upload_id, status, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transfers WHERE code = ? AND active = 1 AND expires_at > ?)
      ON CONFLICT(transfer_code, fingerprint) DO NOTHING`,
    )
      .bind(
        file.id,
        file.transfer_code,
        file.name,
        file.size,
        file.fingerprint,
        file.upload_id,
        file.status,
        file.created_at,
        file.updated_at,
        file.transfer_code,
        now(),
      )
      .run();
    if (!result.meta.changes) {
      if (file.upload_id)
        await c.env.FILES.resumeMultipartUpload(
          objectKey(file),
          file.upload_id,
        ).abort();
      else await c.env.FILES.delete(objectKey(file));
      await getTransfer(c.env.DB, transfer.code);
      const winner = await c.env.DB.prepare(
        "SELECT * FROM files WHERE transfer_code = ? AND fingerprint = ?",
      )
        .bind(transfer.code, file.fingerprint)
        .first<FileRow>();
      if (!winner)
        throw new HTTPException(409, { message: "Upload changed. Try again." });
      return c.json(await describe(c.env.DB, winner));
    }
  } catch (error) {
    if (file.upload_id)
      await c.env.FILES.resumeMultipartUpload(
        objectKey(file),
        file.upload_id,
      ).abort();
    else await c.env.FILES.delete(objectKey(file));
    throw error;
  }
  return c.json(await describe(c.env.DB, file), 201);
});

uploads.get("/:code/:id", async (c) => {
  return c.json(
    await describe(
      c.env.DB,
      await getUploadFile(c.env, c.req.param("code"), c.req.param("id")),
    ),
  );
});

uploads.put("/:code/:id/:part", async (c) => {
  const file = await getUploadFile(
    c.env,
    c.req.param("code"),
    c.req.param("id"),
  );
  const partNumber = Number(c.req.param("part"));
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > Math.ceil(file.size / PART_SIZE)
  ) {
    throw new HTTPException(400, { message: "Invalid part number." });
  }
  if (file.status !== "uploading" || !file.upload_id)
    throw new HTTPException(409, { message: "Upload is already complete." });
  const length = c.req.header("Content-Length");
  const expected = Math.min(
    PART_SIZE,
    file.size - (partNumber - 1) * PART_SIZE,
  );
  if (
    !length ||
    !/^\d+$/.test(length) ||
    Number(length) !== expected ||
    !c.req.raw.body
  ) {
    throw new HTTPException(400, { message: "Incorrect upload part length." });
  }
  const part = await c.env.FILES.resumeMultipartUpload(
    objectKey(file),
    file.upload_id,
  ).uploadPart(partNumber, c.req.raw.body);
  // Do not resurrect metadata if an upload was cancelled while its bytes were in flight.
  await c.env.DB.prepare(
    `INSERT INTO parts(file_id, part_number, etag)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE id = ? AND status = 'uploading')
    ON CONFLICT(file_id, part_number) DO UPDATE SET etag = excluded.etag`,
  )
    .bind(file.id, part.partNumber, part.etag, file.id)
    .run();
  return c.json({ ok: true });
});

uploads.post("/:code/:id/complete", async (c) => {
  const file = await getUploadFile(
    c.env,
    c.req.param("code"),
    c.req.param("id"),
  );
  if (file.status === "complete") return c.json(await describe(c.env.DB, file));
  if (!file.upload_id)
    throw new HTTPException(409, { message: "Upload is not ready." });
  const rows = await c.env.DB.prepare(
    "SELECT part_number, etag FROM parts WHERE file_id = ? ORDER BY part_number",
  )
    .bind(file.id)
    .all<{ part_number: number; etag: string }>();
  if (
    rows.results.length !== Math.ceil(file.size / PART_SIZE) ||
    rows.results.some((p, i) => p.part_number !== i + 1)
  ) {
    throw new HTTPException(409, {
      message: "Some parts are missing. Select the file again to resume.",
    });
  }
  let object = await c.env.FILES.head(objectKey(file));
  if (!object) {
    try {
      object = await c.env.FILES.resumeMultipartUpload(
        objectKey(file),
        file.upload_id,
      ).complete(
        rows.results.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      );
    } catch (error) {
      // Completion may have succeeded even if its response was lost.
      object = await c.env.FILES.head(objectKey(file));
      if (!object) throw error;
    }
  }
  if (object.size !== file.size) {
    await removeFile(c.env, file);
    throw new HTTPException(409, {
      message: "Uploaded size does not match. Upload the file again.",
    });
  }
  const updated = await c.env.DB.prepare(
    `UPDATE files SET status = 'complete', upload_id = NULL, updated_at = ?
    WHERE id = ? AND status = 'uploading' AND EXISTS
    (SELECT 1 FROM transfers WHERE code = ? AND active = 1 AND expires_at > ?)`,
  )
    .bind(now(), file.id, file.transfer_code, now())
    .run();
  if (!updated.meta.changes) {
    const current = await c.env.DB.prepare(
      "SELECT status FROM files WHERE id = ?",
    )
      .bind(file.id)
      .first<{ status: string }>();
    if (current?.status !== "complete") {
      await c.env.FILES.delete(objectKey(file));
      throw new HTTPException(410, {
        message: "Transfer expired or upload was cancelled.",
      });
    }
  }
  await getTransfer(c.env.DB, file.transfer_code);
  return c.json({
    id: file.id,
    status: "complete",
    partSize: PART_SIZE,
    parts: [],
  } satisfies Upload);
});

uploads.delete("/:code/:id", async (c) => {
  const file = await getUploadFile(
    c.env,
    c.req.param("code"),
    c.req.param("id"),
  );
  if (file.status === "complete")
    throw new HTTPException(409, {
      message: "Completed files cannot be cancelled.",
    });
  await removeFile(c.env, file);
  return c.json({ ok: true });
});
