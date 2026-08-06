// The shared file viewer: render any file correctly when someone clicks its name.
//
//   import { fileLink, openFile, closeViewer } from "/file-viewer.js";
//
// WHY THIS IS IN THE SDK rather than in the app that asked for it: the review app
// renders a feedback chain whose entries are files, and the next app will render a
// different list of files. Two apps rendering "a file" two ways is how a studio
// stops feeling like one application — the same reason the header and the rail are
// the shell's and not each surface's.
//
// IT RUNS IN THE APP'S FRAME, not the shell's. It draws no annotation UI and owns
// no annotation state: the shell's overlay already sits above the stage, so a
// viewer opened here is beneath it and can be marked up without this file knowing
// annotation exists. That division is the whole reason the app "ships zero drawing
// UI" is achievable.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() || String(p ?? "");

// Kind comes from the RUNTIME, not from the filename. The verb already decided —
// re-deciding here by extension is two places computing one property, and they
// disagree first on the files that matter (a .txt holding a terminal capture, a
// .md that is really a log).
const ICONS = {
  image: "▣", video: "▶", audio: "♪", markdown: "❡", html: "◈", text: "≡", other: "○",
};

let host = null;      // the modal element, created once
let onKey = null;     // the ESC handler, so it can be removed
let lastFocus = null; // where focus was before opening

function sheet() {
  if (document.querySelector("link[data-studio-file-viewer]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./file-viewer.css", import.meta.url).href;
  link.dataset.studioFileViewer = "";
  document.head.append(link);
}

// A deliberately small markdown subset, applied to ALREADY-ESCAPED text.
//
// ESCAPE FIRST, THEN FORMAT. The order is the whole safety property: a renderer
// that formats first and escapes after will happily emit whatever HTML the file
// contained, and a proof artifact is exactly the kind of file that arrives from
// somewhere else. Nothing here can produce a tag the file asked for.
function markdown(src) {
  const lines = esc(src).split("\n");
  const out = [];
  let inCode = false, inList = false;
  const inline = (t) => t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    // Links: the TEXT is rendered, the href is only allowed for schemes that
    // cannot execute. `javascript:` in a markdown link is the obvious hole.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, href) =>
      /^(https?:|\/|#)/i.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of lines) {
    if (/^```/.test(raw)) { closeList(); out.push(inCode ? "</code></pre>" : "<pre><code>"); inCode = !inCode; continue; }
    if (inCode) { out.push(raw); continue; }
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = raw.match(/^\s*[-*+]\s+(.*)$/);
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (!raw.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (inCode) out.push("</code></pre>");
  closeList();
  return out.join("\n");
}

async function readFile(path) {
  const r = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) {
    // A file that cannot be read must SAY so. Rendering an empty pane here is the
    // failure-borrowing-an-empty-state's-appearance shape: the reader concludes
    // the evidence is blank rather than unreachable, which is the opposite of the
    // conclusion they should draw.
    throw new Error(j?.error || j?.degraded || `could not read ${base(path)} (HTTP ${r.status})`);
  }
  return j;
}

function bodyFor(doc, path) {
  const raw = doc.raw ? doc.raw : null;
  switch (doc.kind) {
    case "image":
      return `<img class="fv-media" src="${esc(raw)}" alt="${esc(base(path))}">`;
    case "video":
      // controls, not autoplay: this opens because someone clicked a filename, and
      // a file that starts making noise on click is a worse answer than one that waits.
      return `<video class="fv-media" src="${esc(raw)}" controls playsinline></video>`;
    case "audio":
      return `<audio class="fv-audio" src="${esc(raw)}" controls></audio>`;
    case "markdown":
      return `<div class="fv-doc">${markdown(doc.content ?? "")}</div>`;
    case "html":
      // SANDBOXED, ALWAYS. An HTML proof artifact is a document from somewhere
      // else; injecting it into this app's DOM would give it this app's origin and
      // its verbs. `sandbox` with no allow-list means no scripts and no same-origin,
      // so it renders and can do nothing.
      return `<iframe class="fv-frame" sandbox srcdoc="${esc(doc.content ?? "")}" title="${esc(base(path))}"></iframe>`;
    case "text":
    default:
      if (doc.content == null && raw) {
        return `<p class="fv-note">This file is not text. <a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">Open it directly</a>.</p>`;
      }
      return `<pre class="fv-pre">${esc(doc.content ?? "")}</pre>`;
  }
}

function ensureHost() {
  if (host) return host;
  sheet();
  host = document.createElement("div");
  host.className = "fv-host";
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-modal", "true");
  host.innerHTML = `
    <div class="fv-backdrop" data-fv-close></div>
    <div class="fv-panel">
      <header class="fv-head">
        <span class="fv-icon" data-fv-icon></span>
        <span class="fv-name" data-fv-name></span>
        <span class="fv-kind" data-fv-kind></span>
        <button class="fv-close" data-fv-close title="close (Esc)" aria-label="close">✕</button>
      </header>
      <div class="fv-body" data-fv-body></div>
    </div>`;
  host.addEventListener("click", (e) => { if (e.target.closest("[data-fv-close]")) closeViewer(); });
  document.body.append(host);
  return host;
}

/** Open a file in the modal viewer. Returns when the content has rendered. */
export async function openFile(path, { title } = {}) {
  const h = ensureHost();
  lastFocus = document.activeElement;
  h.querySelector("[data-fv-name]").textContent = title || base(path);
  h.querySelector("[data-fv-kind]").textContent = "";
  h.querySelector("[data-fv-icon]").textContent = ICONS.other;
  h.querySelector("[data-fv-body]").innerHTML = `<p class="fv-note">Opening ${esc(base(path))}…</p>`;
  h.classList.add("open");
  if (!onKey) {
    onKey = (e) => { if (e.key === "Escape") closeViewer(); };
    window.addEventListener("keydown", onKey);
  }
  h.querySelector(".fv-close").focus();

  try {
    const doc = await readFile(path);
    h.querySelector("[data-fv-icon]").textContent = ICONS[doc.kind] || ICONS.other;
    h.querySelector("[data-fv-kind]").textContent = doc.kind;
    h.querySelector("[data-fv-body]").innerHTML = bodyFor(doc, path);
    return doc;
  } catch (err) {
    h.querySelector("[data-fv-body]").innerHTML =
      `<p class="fv-error">${esc(err.message)}</p>` +
      `<p class="fv-note">The viewer reached the runtime and was refused, or the file is gone. ` +
      `This is not an empty file.</p>`;
    throw err;
  }
}

export function closeViewer() {
  if (!host) return;
  host.classList.remove("open");
  host.querySelector("[data-fv-body]").innerHTML = "";  // stop any playing media
  if (onKey) { window.removeEventListener("keydown", onKey); onKey = null; }
  try { lastFocus?.focus?.(); } catch {}
}

/**
 * A chain entry: ICON + FILENAME, click-to-open. Not a thumbnail.
 *
 * The PRD is explicit and the reason is worth keeping: a feedback chain is a list
 * of things to READ IN ORDER, and a wall of thumbnails turns an ordered story into
 * a contact sheet. The icon says what KIND it is; the name says which one it is.
 */
export function fileLink(path, { title, kind } = {}) {
  const a = document.createElement("button");
  a.type = "button";
  a.className = "fv-link";
  a.innerHTML = `<span class="fv-link-icon">${esc(ICONS[kind] || ICONS.other)}</span><span class="fv-link-name"></span>`;
  a.querySelector(".fv-link-name").textContent = title || base(path);
  a.title = `open ${base(path)}`;
  a.addEventListener("click", () => { openFile(path, { title }).catch(() => {}); });
  return a;
}

/** Which file the viewer is showing, or null. For a caller that needs to ask. */
export function viewerState() {
  if (!host || !host.classList.contains("open")) return { open: false, name: null, kind: null };
  return {
    open: true,
    name: host.querySelector("[data-fv-name]").textContent || null,
    kind: host.querySelector("[data-fv-kind]").textContent || null,
  };
}
