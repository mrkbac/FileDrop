import { z } from "zod";
import {
  MAX_FILE_SIZE,
  codeSchema,
  displayCode,
  formatBytes,
  linkSchema,
  uploadSchema,
} from "./shared";

const message = document.querySelector<HTMLParagraphElement>("#message");
function report(error: unknown): void {
  if (message)
    message.textContent =
      error instanceof Error
        ? error.message
        : "Something went wrong. Please retry.";
}

async function request<T>(
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(
      error.success
        ? error.data.error
        : `Request failed (${response.status}). Please retry.`,
    );
  }
  return schema.parse(body);
}

document
  .querySelector<HTMLFormElement>("#open-transfer")
  ?.addEventListener("submit", (event) => {
    event.preventDefault();
    const parsed = codeSchema.safeParse(
      document.querySelector<HTMLInputElement>("#code")?.value,
    );
    if (!parsed.success)
      return report(
        new Error("Enter all 15 digits. Spaces and hyphens are optional."),
      );
    location.assign(`/t/${displayCode(parsed.data)}`);
  });

document
  .querySelector<HTMLButtonElement>("#generate")
  ?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = true;
    request("/admin/generate", linkSchema, { method: "POST" })
      .then((result) => location.assign(result.url))
      .catch(report)
      .finally(() => {
        button.disabled = false;
      });
  });

document
  .querySelectorAll<HTMLButtonElement>("[data-copy]")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.dataset.copy;
      if (!path) return;
      navigator.clipboard
        .writeText(new URL(path, location.origin).href)
        .then(() => {
          button.textContent = "Copied";
        })
        .catch(report);
    });
  });

document
  .querySelectorAll<HTMLButtonElement>("[data-deactivate]")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const code = button.dataset.deactivate;
      if (
        !code ||
        !confirm(
          "Deactivate this link? Access stops immediately and its files will be deleted.",
        )
      )
        return;
      button.disabled = true;
      request(`/admin/deactivate/${code}`, z.object({ ok: z.literal(true) }), {
        method: "POST",
      })
        .then(() => location.reload())
        .catch(report)
        .finally(() => {
          button.disabled = false;
        });
    });
  });

async function fingerprint(file: File): Promise<string> {
  const metadata = JSON.stringify([file.name, file.size, file.lastModified]);
  const sample = await new Blob([
    metadata,
    file.slice(0, 65536),
    file.slice(Math.max(0, file.size - 65536)),
  ]).arrayBuffer();
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", sample)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

class PartError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function sendPart(
  url: string,
  chunk: Blob,
  signal: AbortSignal,
  progress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) =>
      progress(Math.min(chunk.size, event.loaded));
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let detail = `Upload failed (${xhr.status}). Select the file again to resume.`;
      try {
        const parsed = z
          .object({ error: z.string() })
          .safeParse(JSON.parse(xhr.responseText));
        if (parsed.success) detail = parsed.data.error;
      } catch {
        /* An upstream error may be HTML. */
      }
      reject(new PartError(detail, xhr.status === 429 || xhr.status >= 500));
    };
    xhr.onerror = () =>
      reject(
        new PartError("Connection lost. Select the same file to resume.", true),
      );
    xhr.onabort = () => reject(signal.reason ?? new Error("Upload paused."));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(chunk);
  });
}

async function uploadFile(
  code: string,
  file: File,
  controller: AbortController,
  progress: (loaded: number) => void,
): Promise<void> {
  const { signal } = controller;
  const upload = await request(`/upload/${code}`, uploadSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      fingerprint: await fingerprint(file),
    }),
  });
  if (upload.status === "complete") {
    progress(file.size);
    return;
  }
  const count = Math.ceil(file.size / upload.partSize);
  const completed = new Set(upload.parts);
  const loaded = Array.from({ length: count }, (_, i) =>
    completed.has(i + 1)
      ? Math.min(upload.partSize, file.size - i * upload.partSize)
      : 0,
  );
  const update = () => progress(loaded.reduce((sum, value) => sum + value, 0));
  update();
  let nextPart = 1;
  const worker = async () => {
    while (nextPart <= count) {
      signal.throwIfAborted();
      const part = nextPart++;
      if (completed.has(part)) continue;
      const offset = (part - 1) * upload.partSize;
      const chunk = file.slice(
        offset,
        Math.min(file.size, offset + upload.partSize),
      );
      for (let attempt = 0; ; attempt++) {
        try {
          await sendPart(
            `/upload/${code}/${upload.id}/${part}`,
            chunk,
            signal,
            (bytes) => {
              loaded[part - 1] = bytes;
              update();
            },
          );
          loaded[part - 1] = chunk.size;
          update();
          break;
        } catch (error) {
          loaded[part - 1] = 0;
          update();
          if (
            signal.aborted ||
            !(error instanceof PartError) ||
            !error.retryable ||
            attempt >= 4
          )
            throw error;
          await delay(Math.min(8000, 500 * 2 ** attempt), signal);
        }
      }
    }
  };
  const workers = Array.from({ length: Math.min(3, count) }, () => worker());
  try {
    await Promise.all(workers);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(workers);
    throw error;
  }
  await request(`/upload/${code}/${upload.id}/complete`, uploadSchema, {
    method: "POST",
    signal,
  });
}

const transfer = document.querySelector<HTMLElement>("#transfer");
const input = document.querySelector<HTMLInputElement>("#files");
const button = document.querySelector<HTMLButtonElement>("#upload");
const queue = document.querySelector<HTMLElement>("#queue");
const dropZone = document.querySelector<HTMLElement>("#drop-zone");
const code = transfer?.dataset.code;

if (input && button && queue && dropZone && code) {
  let selected: File[] = [];
  let running = false;
  const select = (files: FileList | null) => {
    if (running) return;
    selected = Array.from(files ?? []);
    queue.replaceChildren();
    if (message) message.textContent = "";
    button.disabled = !selected.length;
    for (const file of selected) {
      const row = document.createElement("p");
      row.textContent = `${file.name} · ${formatBytes(file.size)}`;
      queue.append(row);
      if (file.size > MAX_FILE_SIZE) {
        button.disabled = true;
        report(new Error(`${file.name} exceeds the 100 GB limit.`));
      }
    }
  };
  input.addEventListener("change", () => select(input.files));
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("dragging"),
  );
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    select(event.dataTransfer?.files ?? null);
  });
  window.addEventListener("beforeunload", (event) => {
    if (running) event.preventDefault();
  });

  button.addEventListener("click", () => {
    const run = async () => {
      running = true;
      button.disabled = true;
      input.disabled = true;
      queue.replaceChildren();
      let allComplete = true;
      try {
        for (const file of selected) {
          const row = document.createElement("div");
          row.className = "queue-item";
          const name = document.createElement("div");
          name.className = "file-name";
          name.textContent = file.name;
          const progress = document.createElement("progress");
          progress.max = file.size || 1;
          progress.value = 0;
          progress.setAttribute("aria-label", `Uploading ${file.name}`);
          const status = document.createElement("span");
          status.textContent = "Preparing…";
          const pause = document.createElement("button");
          pause.textContent = "Pause";
          pause.className = "secondary";
          const controller = new AbortController();
          pause.addEventListener("click", () =>
            controller.abort(
              new Error("Paused. Select the same file again to resume."),
            ),
          );
          row.append(
            name,
            progress,
            status,
            document.createTextNode(" "),
            pause,
          );
          queue.append(row);
          try {
            await uploadFile(code, file, controller, (loaded) => {
              progress.value = loaded;
              status.textContent =
                loaded === file.size
                  ? "Finishing…"
                  : `${formatBytes(loaded)} / ${formatBytes(file.size)}`;
            });
            progress.value = file.size || 1;
            status.textContent = "Complete";
          } catch (error) {
            allComplete = false;
            status.textContent =
              error instanceof Error
                ? error.message
                : "Upload interrupted. Try again to resume.";
          } finally {
            pause.remove();
          }
        }
      } finally {
        running = false;
        input.disabled = false;
        button.disabled = false;
        button.textContent = "Resume uploads";
      }
      if (allComplete) location.reload();
    };
    run().catch(report);
  });
}
