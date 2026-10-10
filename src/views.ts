import { html } from "hono/html";
import { displayCode, formatBytes } from "./shared";
import type { FileRow, Transfer } from "./store";

const page = (title: string, content: ReturnType<typeof html>) =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title} · FileDrop</title>
        <link rel="stylesheet" href="/assets/style.css" />
        <script type="module" src="/assets/client.js"></script>
      </head>
      <body>
        <main class="layout">
          <header>
            <a class="wordmark" href="/">file<span>drop</span></a
            ><a href="/admin">Staff</a>
          </header>
          ${content}
          <p id="message" role="status" aria-live="polite"></p>
          <footer>Temporary file transfer · Sensmore</footer>
        </main>
      </body>
    </html>`;

export const homePage = () =>
  page(
    "Open a transfer",
    html` <h1>Have a transfer code?</h1>
      <p>Enter the code to upload or download files.</p>
      <form id="open-transfer">
        <label for="code">Transfer code</label>
        <input
          id="code"
          name="code"
          inputmode="numeric"
          autocomplete="off"
          placeholder="123-456-789-012-345"
          required
          maxlength="40"
        />
        <button type="submit">Open transfer</button>
      </form>
      <p>Team members: <a href="/admin">sign in to create a link</a>.</p>`,
  );

export interface TransferSummary extends Transfer {
  file_count: number;
  total_size: number;
}

export const dashboardPage = (email: string, links: TransferSummary[]) =>
  page(
    "Your transfers",
    html` <p class="muted">${email}</p>
      <div class="heading">
        <h1>Your transfers</h1>
        <button id="generate">New transfer</button>
      </div>
      <p>
        Each link expires after 30 days. Anyone with the link can upload and
        download its files.
      </p>
      <div class="links-list">
        ${
          links.length
            ? links.map(
                (link) =>
                  html` <section class="link-card">
                    <a class="code" href="/t/${displayCode(link.code)}"
                      >${displayCode(link.code)}</a
                    >
                    <p>
                      ${link.file_count} files · ${formatBytes(link.total_size)}
                      · expires ${date(link.expires_at)}
                    </p>
                    <div class="actions">
                      <button data-copy="/t/${displayCode(link.code)}">
                        Copy link
                      </button>
                      <button class="secondary" data-deactivate="${link.code}">
                        Deactivate
                      </button>
                    </div>
                  </section>`,
              )
            : html`<p>No active transfers yet.</p>`
        }
      </div>`,
  );

export const transferPage = (transfer: Transfer, files: FileRow[]) =>
  page(
    "Transfer",
    html` <section id="transfer" data-code="${transfer.code}">
      <h1 class="code">${displayCode(transfer.code)}</h1>
      <p>
        Expires ${date(transfer.expires_at)}. Anyone with this link can upload
        and download these files.
      </p>
      <button data-copy="/t/${displayCode(transfer.code)}">Copy link</button>
      <h2>Upload files</h2>
      <label class="drop-zone" id="drop-zone" for="files">
        <span>Drop files here or choose files</span
        ><input id="files" type="file" multiple />
        <span class="muted">Up to 100 GB per file</span></label
      >
      <p class="muted">
        Keep this tab open while uploading. If interrupted, select the same file
        again within 7 days to resume.
      </p>
      <div id="queue" aria-live="polite"></div>
      <button id="upload" disabled>Upload files</button>
      <h2>Download files</h2>
      <div id="files-list">
        ${
          files.length
            ? files.map(
                (file) =>
                  html` <div class="file-row">
                    <div>
                      <div class="file-name">${file.name}</div>
                      <span class="muted">${formatBytes(file.size)}</span>
                    </div>
                    <a
                      class="download"
                      href="/download/${displayCode(transfer.code)}/${file.id}/${encodeURIComponent(file.name)}"
                      >Download</a
                    >
                  </div>`,
              )
            : html`<p>No files uploaded yet.</p>`
        }
      </div>
    </section>`,
  );

export const unavailablePage = () =>
  page(
    "Transfer unavailable",
    html`<h1>Transfer unavailable</h1>
      <p>
        This link has expired, was deactivated, or the code is incorrect. Ask
        the sender for a new link.
      </p>
      <a href="/">Enter another code</a>`,
  );

function date(seconds: number): string {
  return `${new Date(seconds * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}
