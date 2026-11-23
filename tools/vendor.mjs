// The workspace's /vendor/ byte route: which file a request names, and what it is.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Two defects this replaces: the route sent no content-type, so a browser refused a vendored ES module (.mjs) loaded
// with <script type="module">; and it contained requests with a bare prefix test, so /vendor/../vendor-x/f (a sibling
// folder whose name merely starts with the vendor folder's) passed. Containment is now "inside the folder, separator
// included", and only regular files are served.
//
// Third: the route said 'public, max-age=31536000, immutable', which is only safe for content-addressed paths. These
// aren't: an app's vendor/ holds its own code at fixed names, so a returning browser ran the OLD app after a cut. Now
// every response carries 'no-cache' + an ETag, and a matching If-None-Match is a 304: unchanged files cost a
// revalidation, a changed file is fetched on the very next load.
export const VENDOR_CACHE = "no-cache";
export const notModified = (ifNoneMatch, etag) =>
  typeof ifNoneMatch === "string" &&
  ifNoneMatch
    .split(",")
    .map((s) => s.trim())
    .some((t) => t === etag || t === "*");
import fs from "node:fs";
import path from "node:path";

// Apps keep their own assets; explicitly declared vendor names can also come
// from the shared Apps-root vendor directory, without enabling another app.
export function vendorDirectory(appsRoot, appDir, name) {
  const own = path.join(appDir, "vendor", name);
  return fs.existsSync(own) ? own : path.join(appsRoot, "vendor", name);
}

export const VENDOR_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

// -> { file, type } for a servable file inside `root`, else null.
export function vendorFile(root, rel) {
  const base = path.resolve(root);
  const f = path.resolve(base, rel);
  if (f !== base && !f.startsWith(base + path.sep)) return null;
  let st;
  try {
    st = fs.statSync(f);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  // A validator for revalidation: the workspace re-copies vendor files on every compose, so a cut changes it.
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}-${st.ino.toString(36)}"`;
  return {
    file: f,
    type: VENDOR_TYPES[path.extname(f).toLowerCase()] || "application/octet-stream",
    etag,
  };
}
