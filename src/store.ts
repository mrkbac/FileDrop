import { HTTPException } from "hono/http-exception";
import { RETENTION_SECONDS, UPLOAD_SECONDS, codeSchema } from "./shared";

export interface Transfer {
  code: string;
  owner: string;
  created_at: number;
  expires_at: number;
  active: number;
}

export interface FileRow {
  id: string;
  transfer_code: string;
  name: string;
  size: number;
  fingerprint: string;
  upload_id: string | null;
  status: "uploading" | "complete" | "deleting";
  created_at: number;
  updated_at: number;
}

export const now = (): number => Math.floor(Date.now() / 1000);
export const objectKey = (file: FileRow): string =>
  `transfers/${file.transfer_code}/${file.id}`;

export async function getTransfer(
  db: D1Database,
  rawCode: string,
): Promise<Transfer> {
  const parsed = codeSchema.safeParse(rawCode);
  const transfer = parsed.success
    ? await db
        .prepare(
          "SELECT * FROM transfers WHERE code = ? AND active = 1 AND expires_at > ?",
        )
        .bind(parsed.data, now())
        .first<Transfer>()
    : null;
  if (!transfer)
    throw new HTTPException(410, {
      message: "This link has expired or been deactivated.",
    });
  return transfer;
}

export async function createTransfer(
  db: D1Database,
  owner: string,
): Promise<Transfer> {
  const timestamp = now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const groups: string[] = [];
    while (groups.length < 5) {
      const value = crypto.getRandomValues(new Uint16Array(1))[0];
      if (value !== undefined && value < 65000)
        groups.push(String(value % 1000).padStart(3, "0"));
    }
    const code = groups.join("");
    const result = await db
      .prepare(
        "INSERT INTO transfers(code, owner, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .bind(code, owner, timestamp, timestamp + RETENTION_SECONDS)
      .run();
    if (result.meta.changes === 1)
      return {
        code,
        owner,
        created_at: timestamp,
        expires_at: timestamp + RETENTION_SECONDS,
        active: 1,
      };
  }
  throw new Error("Could not allocate transfer code");
}

export async function getFile(
  db: D1Database,
  code: string,
  id: string,
): Promise<FileRow> {
  const file = await db
    .prepare(
      "SELECT * FROM files WHERE id = ? AND transfer_code = ? AND status != 'deleting'",
    )
    .bind(id, code)
    .first<FileRow>();
  if (
    !file ||
    (file.status === "uploading" && file.created_at + UPLOAD_SECONDS <= now())
  ) {
    throw new HTTPException(404, {
      message: "Upload not found. Select the file again to start a new upload.",
    });
  }
  return file;
}

export async function removeFile(env: Env, file: FileRow): Promise<void> {
  // Keep the tombstone until R2 cleanup succeeds so a failed cron can retry safely.
  await env.DB.prepare("UPDATE files SET status = 'deleting' WHERE id = ?")
    .bind(file.id)
    .run();
  if (file.upload_id) {
    try {
      await env.FILES.resumeMultipartUpload(
        objectKey(file),
        file.upload_id,
      ).abort();
    } catch (error) {
      // R2 lifecycle may already have removed the unfinished upload.
      if (!(error instanceof Error) || !/\(10024\)$/.test(error.message))
        throw error;
    }
  }
  await env.FILES.delete(objectKey(file));
  await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(file.id).run();
}

export async function cleanup(env: Env): Promise<void> {
  const expired = await env.DB.prepare(
    `SELECT f.* FROM files f JOIN transfers t ON t.code = f.transfer_code
    WHERE t.active = 0 OR t.expires_at <= ? OR f.status = 'deleting'
       OR (f.status = 'uploading' AND f.created_at <= ?) LIMIT 200`,
  )
    .bind(now(), now() - UPLOAD_SECONDS)
    .all<FileRow>();
  let failed = 0;
  for (const file of expired.results) {
    try {
      await removeFile(env, file);
    } catch {
      failed++;
    }
  }
  await env.DB.prepare(
    `DELETE FROM transfers WHERE (active = 0 OR expires_at <= ?)
    AND NOT EXISTS (SELECT 1 FROM files WHERE transfer_code = transfers.code)`,
  )
    .bind(now())
    .run();
  console.log(
    JSON.stringify({
      event: "cleanup",
      removed: expired.results.length - failed,
      failed,
    }),
  );
  if (failed)
    throw new Error(
      "Some expired files could not be removed; cleanup will retry",
    );
}
