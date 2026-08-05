#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(arg("--port", 8798));
const ROOT = path.resolve(arg("--root", "./artifacts"));
fs.mkdirSync(ROOT, { recursive: true });

const json = (res, code, value) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 8_000_000) reject(new Error("request body is too large"));
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
const safeId = (value) => {
  const id = String(value || "").trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
};
const artifactDir = (id) => path.join(ROOT, id);
const assetsDir = (id) => path.join(artifactDir(id), "assets");
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const metaFor = (id) => {
  const meta = readJson(path.join(artifactDir(id), "meta.json"), null);
  return meta ? { ...meta, type: meta.type === "canvas" ? "canvas" : "document" } : null;
};
const list = () => fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && safeId(entry.name))
  .map((entry) => metaFor(entry.name))
  .filter(Boolean)
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
const annotationsFor = (id) => readJson(path.join(artifactDir(id), "annotations.json"), []);
const itemsFor = (id) => readJson(path.join(artifactDir(id), "items.json"), []);
const annotationStoreFile = path.join(ROOT, "annotations-scopes.json");
const htmlEscape = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[char]));
const canvasHtml = (id) => {
  const canvasItems = itemsFor(id);
  const items = canvasItems.map((item) => `<figure class="canvas-item" id="${htmlEscape(item.id)}" data-item-id="${htmlEscape(item.id)}" data-annotate-id="${htmlEscape(item.id)}" data-item-name="${htmlEscape(item.name)}" style="left:${Number(item.x)}px;top:${Number(item.y)}px;width:${Number(item.width)}px"><img src="${htmlEscape(item.src)}" alt="${htmlEscape(item.name)}" draggable="false"><figcaption>${htmlEscape(item.name)}</figcaption></figure>`).join("");
  const empty = canvasItems.length ? "" : '<div class="canvas-empty"><strong>Paste screenshots here</strong><span>Drag to arrange · scroll to zoom · drag the board to pan</span></div>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden}body{background:#d8d5cd;color:#1b1b1d;font:13px/1.35 Helvetica,Arial,sans-serif;user-select:none}.canvas-world{position:absolute;left:0;top:0;width:2400px;height:1600px;transform-origin:0 0;background-color:#efede7;background-image:linear-gradient(rgba(24,24,28,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(24,24,28,.06) 1px,transparent 1px);background-size:32px 32px;box-shadow:0 0 0 1px rgba(24,24,28,.12)}.canvas-empty{position:absolute;left:520px;top:390px;width:520px;padding:70px 40px;border:1px dashed rgba(24,24,28,.24);text-align:center;color:#5b5b61}.canvas-empty strong{display:block;margin-bottom:8px;color:#242428;font-size:24px;letter-spacing:-.03em}.canvas-empty span{font-size:14px}.canvas-item{position:absolute;margin:0;padding:8px;background:#fff;border:1px solid rgba(24,24,28,.18);box-shadow:0 10px 30px rgba(25,25,29,.18);cursor:grab}.canvas-item:active{cursor:grabbing}.canvas-item img{display:block;width:100%;height:auto;pointer-events:none}.canvas-item figcaption{padding:7px 2px 1px;font-size:11px;color:#5b5b61;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}</style></head><body data-artifact-type="canvas"><main class="canvas-world" data-canvas-world>${empty}${items}</main></body></html>`;
};
const touchMeta = (id) => {
  const meta = { ...metaFor(id), updatedAt: new Date().toISOString() };
  writeJson(path.join(artifactDir(id), "meta.json"), meta);
  return meta;
};
const normaliseAnnotation = (input, existing = {}) => ({
  id: String(input.id || existing.id || crypto.randomUUID()),
  surfaceId: String(input.surfaceId || existing.surfaceId || "artifacts"),
  shape: ["circle", "rect", "arrow", "text", "free"].includes(input.shape) ? input.shape : (existing.shape || "circle"),
  note: String(input.note ?? existing.note ?? "").trim(),
  source: input.source === "agent" ? "agent" : (existing.source || "human"),
  selector: input.selector == null ? (existing.selector || null) : String(input.selector || "").trim() || null,
  tag: input.tag == null ? (existing.tag || null) : String(input.tag || "").toLowerCase() || null,
  text: input.text == null ? (existing.text || null) : String(input.text || "").trim().slice(0, 240) || null,
  anchor: input.anchor && ["x", "y", "width", "height"].every((k) => Number.isFinite(Number(input.anchor[k])))
    ? Object.fromEntries(["x", "y", "width", "height"].map((k) => [k, Number(input.anchor[k])]))
    : (existing.anchor || null),
  offset: Object.hasOwn(input, "offset") && input.offset == null
    ? null
    : input.offset && ["x", "y"].every((k) => Number.isFinite(Number(input.offset[k])))
      ? Object.fromEntries(["x", "y", "width", "height"]
        .filter((k) => Number.isFinite(Number(input.offset[k])))
        .map((k) => [k, Number(input.offset[k])]))
      : (existing.offset || null),
  points: Array.isArray(input.points) ? input.points.slice(0, 240).map((p) => [Number(p[0]), Number(p[1])]) : (existing.points || null),
  status: input.status === "missing" ? "missing" : (input.status === "anchored" ? "anchored" : (existing.status || (input.selector ? "missing" : "spatial"))),
  createdAt: existing.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
const readAnnotationStore = () => {
  const value = readJson(annotationStoreFile, {});
  return {
    scopes: value.scopes && typeof value.scopes === "object" ? value.scopes : {},
    artifacts: value.artifacts && typeof value.artifacts === "object" ? value.artifacts : {},
  };
};
const writeAnnotationStore = (store) => writeJson(annotationStoreFile, store);
const recordsForScope = (store, scope) => Array.isArray(store.scopes[scope]) ? store.scopes[scope] : [];
const dropArtifactScope = (id) => {
  const store = readAnnotationStore();
  const scope = store.artifacts[id];
  if (!scope) return;
  delete store.artifacts[id];
  delete store.scopes[scope];
  writeAnnotationStore(store);
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://artifacts.local");
  try {
    if (url.pathname === "/") return json(res, 200, { ok: true, provider: "@openrig/studio-artifacts", root: ROOT });

    if (url.pathname === "/api/annotations" && req.method === "GET") {
      const scope = url.searchParams.get("scope");
      if (!scope) return json(res, 200, { ok: true, scope: "", records: [] });
      const store = readAnnotationStore();
      return json(res, 200, { ok: true, scope, records: recordsForScope(store, scope) });
    }
    if (url.pathname === "/api/annotations" && req.method === "POST") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const scope = typeof input.scope === "string" ? input.scope : "";
      if (!scope) return json(res, 400, { ok: false, error: "annotation scope is required" });
      if (!Array.isArray(input.records)) return json(res, 400, { ok: false, error: "annotation records must be an array" });
      const store = readAnnotationStore();
      const prior = new Map(recordsForScope(store, scope).map((record) => [record.id, record]));
      const records = input.records.map((record) => normaliseAnnotation(record, prior.get(record.id) || {}));
      store.scopes[scope] = records;
      writeAnnotationStore(store);
      return json(res, 200, { ok: true, scope, records });
    }

    if (url.pathname === "/api/artifacts" && req.method === "GET") {
      return json(res, 200, { ok: true, artifacts: list() });
    }
    if (url.pathname === "/api/artifacts" && req.method === "POST") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const id = safeId(input.id);
      if (!id) return json(res, 400, { ok: false, error: "id must use lowercase letters, numbers and hyphens" });
      const dir = artifactDir(id);
      if (fs.existsSync(dir)) return json(res, 409, { ok: false, error: `artifact ${id} already exists` });
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      const meta = { id, name: String(input.name || id).trim().slice(0, 120), type: input.type === "canvas" ? "canvas" : "document", createdAt: now, updatedAt: now };
      fs.writeFileSync(path.join(dir, "artifact.html"), String(input.html || ""));
      writeJson(path.join(dir, "meta.json"), meta);
      writeJson(path.join(dir, "annotations.json"), []);
      writeJson(path.join(dir, "items.json"), []);
      return json(res, 201, { ok: true, artifact: meta });
    }

    if (url.pathname === "/api/artifacts/item") {
      const id = safeId(url.searchParams.get("id"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      if (req.method === "GET") return json(res, 200, {
        ok: true,
        artifact: metaFor(id),
        html: fs.readFileSync(path.join(artifactDir(id), "artifact.html"), "utf8"),
      });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        if (typeof input.html !== "string") return json(res, 400, { ok: false, error: "html is required" });
        fs.writeFileSync(path.join(artifactDir(id), "artifact.html"), input.html);
        const meta = { ...metaFor(id), name: String(input.name || metaFor(id).name).trim().slice(0, 120), updatedAt: new Date().toISOString() };
        writeJson(path.join(artifactDir(id), "meta.json"), meta);
        return json(res, 200, { ok: true, artifact: meta });
      }
      if (req.method === "DELETE") {
        dropArtifactScope(id);
        fs.rmSync(artifactDir(id), { recursive: true });
        return json(res, 200, { ok: true, deleted: id });
      }
    }

    if (url.pathname === "/api/artifacts/annotations/migrate" && req.method === "POST") {
      const id = safeId(url.searchParams.get("artifact"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      const input = JSON.parse((await readBody(req)) || "{}");
      const scope = typeof input.scope === "string" ? input.scope : "";
      if (!scope) return json(res, 400, { ok: false, error: "annotation scope is required" });
      const store = readAnnotationStore();
      const exists = Object.hasOwn(store.scopes, scope);
      if (!exists) store.scopes[scope] = annotationsFor(id).map((record) => normaliseAnnotation(record));
      store.artifacts[id] = scope;
      writeAnnotationStore(store);
      return json(res, 200, { ok: true, artifact: id, scope, migrated: !exists, records: recordsForScope(store, scope) });
    }

    if (url.pathname === "/api/artifacts/annotations") {
      const id = safeId(url.searchParams.get("artifact"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      if (req.method === "GET") return json(res, 200, { ok: true, artifact: id, annotations: annotationsFor(id) });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        const annotations = annotationsFor(id);
        const at = annotations.findIndex((item) => item.id === input.id);
        const annotation = normaliseAnnotation(input, at >= 0 ? annotations[at] : {});
        if (at >= 0) annotations[at] = annotation; else annotations.push(annotation);
        writeJson(path.join(artifactDir(id), "annotations.json"), annotations);
        return json(res, at >= 0 ? 200 : 201, { ok: true, annotation });
      }
      if (req.method === "DELETE") {
        const annotationId = String(url.searchParams.get("id") || "");
        const annotations = annotationsFor(id);
        const next = annotations.filter((item) => item.id !== annotationId);
        if (!annotationId || next.length === annotations.length) return json(res, 404, { ok: false, error: "annotation not found" });
        writeJson(path.join(artifactDir(id), "annotations.json"), next);
        return json(res, 200, { ok: true, deleted: annotationId });
      }
    }

    if (url.pathname === "/api/artifacts/assets") {
      const id = safeId(url.searchParams.get("artifact"));
      const meta = id && metaFor(id);
      if (!id || !meta) return json(res, 404, { ok: false, error: "artifact not found" });
      if (req.method === "GET") return json(res, 200, { ok: true, artifact: id, items: itemsFor(id) });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        const mime = String(input.mime || "").toLowerCase();
        const extensions = { "image/png":"png", "image/jpeg":"jpg", "image/gif":"gif", "image/webp":"webp" };
        if (!extensions[mime]) return json(res, 400, { ok: false, error: "paste a PNG, JPEG, GIF or WebP image" });
        const encoded = String(input.data || "").replace(/^data:[^;]+;base64,/, "");
        const bytes = Buffer.from(encoded, "base64");
        if (!bytes.length || bytes.length > 6_000_000) return json(res, 400, { ok: false, error: "image must be between 1 byte and 6 MB" });
        const token = crypto.randomUUID();
        const itemId = `image-${token.slice(0, 8)}`;
        const file = `${token}.${extensions[mime]}`;
        fs.mkdirSync(assetsDir(id), { recursive: true });
        fs.writeFileSync(path.join(assetsDir(id), file), bytes);
        const name = String(input.name || "Pasted image").trim().slice(0, 120) || "Pasted image";
        const item = { id: itemId, name, src: `/artifacts/${id}/assets/${file}`, x: Number.isFinite(Number(input.x)) ? Number(input.x) : 160, y: Number.isFinite(Number(input.y)) ? Number(input.y) : 120, width: Math.max(120, Math.min(1200, Number(input.width) || 420)), createdAt: new Date().toISOString() };
        const items = itemsFor(id);
        items.push(item);
        writeJson(path.join(artifactDir(id), "items.json"), items);
        if (meta.type !== "canvas") {
          const filePath = path.join(artifactDir(id), "artifact.html");
          const html = fs.readFileSync(filePath, "utf8");
          const block = `<figure id="${item.id}" data-annotate-id="${item.id}" data-item-name="${htmlEscape(name)}" style="margin:32px auto;max-width:960px"><img src="${item.src}" alt="${htmlEscape(name)}" style="display:block;max-width:100%;height:auto"><figcaption style="margin-top:8px;color:#6b6863;font:12px Helvetica,Arial,sans-serif">${htmlEscape(name)}</figcaption></figure>`;
          fs.writeFileSync(filePath, /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${block}</body>`) : `${html}${block}`);
        }
        touchMeta(id);
        return json(res, 201, { ok: true, artifact: id, item });
      }
    }

    if (url.pathname === "/api/artifacts/items") {
      const id = safeId(url.searchParams.get("artifact"));
      const meta = id && metaFor(id);
      if (!id || !meta || meta.type !== "canvas") return json(res, 404, { ok: false, error: "canvas artifact not found" });
      if (req.method === "GET") return json(res, 200, { ok: true, artifact: id, items: itemsFor(id) });
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        const items = itemsFor(id);
        const at = items.findIndex((item) => item.id === input.item || item.name === input.item);
        if (at < 0) return json(res, 404, { ok: false, error: `canvas item ${input.item || ""} not found` });
        const item = { ...items[at] };
        for (const key of ["x", "y", "width"]) if (Number.isFinite(Number(input[key]))) item[key] = Number(input[key]);
        item.width = Math.max(120, Math.min(1200, item.width));
        items[at] = item;
        writeJson(path.join(artifactDir(id), "items.json"), items);
        touchMeta(id);
        return json(res, 200, { ok: true, artifact: id, item });
      }
    }

    if (url.pathname === "/api/artifacts/screenshot") {
      const id = safeId(url.searchParams.get("artifact"));
      if (!id || !metaFor(id)) return json(res, 404, { ok: false, error: "artifact not found" });
      const file = path.join(artifactDir(id), "screenshot.svg");
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)) || "{}");
        if (!String(input.svg || "").startsWith("<svg")) return json(res, 400, { ok: false, error: "svg screenshot is required" });
        fs.writeFileSync(file, input.svg);
        return json(res, 200, { ok: true, path: `/api/artifacts/screenshot?artifact=${id}` });
      }
      if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: "no rendered screenshot yet" });
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(file).pipe(res);
    }

    if (url.pathname.startsWith("/artifacts/")) {
      const asset = url.pathname.match(/^\/artifacts\/([a-z0-9][a-z0-9-]{0,63})\/assets\/([a-f0-9-]+\.(?:png|jpg|gif|webp))$/);
      if (asset && metaFor(asset[1])) {
        const file = path.join(assetsDir(asset[1]), asset[2]);
        if (!fs.existsSync(file)) { res.writeHead(404); return res.end("asset not found"); }
        const type = { png:"image/png", jpg:"image/jpeg", gif:"image/gif", webp:"image/webp" }[path.extname(file).slice(1)];
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
        return fs.createReadStream(file).pipe(res);
      }
      const match = url.pathname.match(/^\/artifacts\/([a-z0-9][a-z0-9-]{0,63})\/artifact\.html$/);
      if (!match || !metaFor(match[1])) { res.writeHead(404); return res.end("artifact not found"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (metaFor(match[1]).type === "canvas") return res.end(canvasHtml(match[1]));
      return fs.createReadStream(path.join(artifactDir(match[1]), "artifact.html")).pipe(res);
    }
    res.writeHead(404); res.end();
  } catch (error) {
    json(res, 500, { ok: false, error: String(error.message || error) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`studio-artifacts: http://127.0.0.1:${PORT}/ root=${ROOT}`);
});
