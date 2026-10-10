import { z } from "zod";

export const MAX_FILE_SIZE = 100_000_000_000;
export const PART_SIZE = 32 * 1024 * 1024;
export const RETENTION_SECONDS = 30 * 86400;
export const UPLOAD_SECONDS = 7 * 86400;

export function normalizeCode(value: string): string {
  return value.replace(/[\s-]/g, "");
}

export function displayCode(code: string): string {
  return code.match(/.{1,3}/g)?.join("-") ?? code;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export const codeSchema = z
  .string()
  .transform(normalizeCode)
  .pipe(z.string().regex(/^\d{15}$/));
export const startSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(240)
    .refine((s) => !/[\x00-\x1f\x7f/\\]/.test(s), "Invalid filename"),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const uploadSchema = z.object({
  id: z.uuid(),
  status: z.enum(["uploading", "complete"]),
  partSize: z.number().int().positive(),
  parts: z.array(z.number().int().positive()),
});
export const linkSchema = z.object({ url: z.string(), code: z.string() });
export type Upload = z.infer<typeof uploadSchema>;
