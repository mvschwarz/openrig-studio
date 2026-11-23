// A generated app's static files, served read-only from one fixed folder (tools/project-app-server.mjs).
// The caller has already admitted the request; this only decides which file, if any, answers it.
//
// - Only GET and HEAD. Nothing here writes, lists a folder or runs code.
// - Only under /project-apps/<app>/. Every other path is 404, so no Studio route can be reached through it.
// - The file is resolved with realpath and must stay inside the app's folder, so a symlink or an encoded
//   ".." can't lead out of it.
// - Read live on every request (no-store), so an edit to the app shows on the next load.
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

// `root` must already be a realpath: containment is checked against it.
export function serveProjectApp(req, res, url, { app, root }) {
  const prefix = `/project-apps/${app}/`;
  const end = (code, headers = {}) => {
    res.writeHead(code, { "cache-control": "no-store", ...headers });
    res.end();
    return true;
  };
  if (req.method !== "GET" && req.method !== "HEAD") return end(405, { allow: "GET, HEAD" });
  if (url.pathname === "/" || url.pathname === prefix.slice(0, -1))
    return end(308, { location: prefix + url.search });
  if (!url.pathname.startsWith(prefix)) return end(404);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return end(400);
  }
  if (rel.split("/").some((p) => p === "." || p === ".." || /[\\\0]/.test(p))) return end(404);
  let file, stat;
  try {
    file = fs.realpathSync(path.join(root, rel || "index.html"));
    if (!file.startsWith(root + path.sep)) return end(404);
    stat = fs.statSync(file);
  } catch {
    return end(404);
  }
  if (!stat.isFile()) return end(404);
  res.writeHead(200, {
    "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": stat.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else
    fs.createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  return true;
}
