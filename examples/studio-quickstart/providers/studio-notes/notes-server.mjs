#!/usr/bin/env node
// Example provider for the quickstart Notes app. It answers two verbs over the folder bound to the
// `notes` root kind, and nothing else: GET /api/notes lists the .md files, GET /api/notes/item?name=<file>
// returns one. Read-only. The Studio starts it with --port and --root from provider.json and routes
// the declared verbs to it on the Studio's own origin.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("--port"));
const root = arg("--root") ? path.resolve(arg("--root")) : null;
if (!port || !root) {
  console.error("studio-notes: needs --port and --root (bind the `notes` root in studio.json)");
  process.exit(2);
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const list = () =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => {
      const s = fs.statSync(path.join(root, d.name));
      return { name: d.name, bytes: s.size, modified: s.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method !== "GET") return send(res, 405, { error: "read-only: GET only" });
    try {
      if (url.pathname === "/api/notes")
        return send(res, 200, { root: path.basename(root), notes: list() });
      if (url.pathname === "/api/notes/item") {
        const name = url.searchParams.get("name") ?? "";
        // Only a plain file name from the listing: no paths, so a request can't leave the bound folder.
        if (!list().some((n) => n.name === name))
          return send(res, 404, { error: `no note named ${JSON.stringify(name)}` });
        return send(res, 200, { name, text: fs.readFileSync(path.join(root, name), "utf8") });
      }
      return send(res, 404, { error: "unknown verb" });
    } catch (e) {
      return send(res, 503, { error: `couldn't read the notes folder: ${e.message}` });
    }
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`studio-notes: http://127.0.0.1:${port}/api/notes reading ${root}`),
  );
