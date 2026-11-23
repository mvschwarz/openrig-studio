// A generated app's static files (tools/project-app-assets.mjs): what is served, and that nothing outside the app's
// folder can be reached, by a symlink, an encoded path or a write.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { serveProjectApp } from "../tools/project-app-assets.mjs";

async function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "project-app-"));
  const work = path.join(tmp, "work"),
    project = path.join(work, "project", "checklist");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(project, "index.html"),
    '<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
  );
  fs.writeFileSync(path.join(project, "style.css"), "body{color:green}");
  fs.writeFileSync(path.join(project, "app.js"), "globalThis.loaded=true;");
  const server = http.createServer((req, res) => {
    if (
      !serveProjectApp(req, res, new URL(req.url, "http://x"), {
        app: "checklist",
        root: fs.realpathSync(project),
      })
    ) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    tmp,
    work,
    project,
    base,
    request: (p = "", init) => fetch(`${base}/project-apps/checklist${p}`, init),
  };
}

test("unchanged relative assets resolve, HEAD is exact, and edits are read live", async (t) => {
  const { project, request } = await fixture(t);
  const redirect = await request("", { redirect: "manual" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/project-apps/checklist/");
  for (const name of ["index.html", "style.css", "app.js"]) {
    const r = await request(name === "index.html" ? "/" : `/${name}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), fs.readFileSync(path.join(project, name)));
  }
  assert.match((await request("/app.js")).headers.get("content-type"), /javascript/);
  const head = await request("/style.css", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "17");
  assert.equal(await head.text(), "");
  fs.writeFileSync(path.join(project, "app.js"), "globalThis.edited=true;");
  assert.equal(await (await request("/app.js")).text(), "globalThis.edited=true;");
});

test("only the fixed project folder is exposed, including symlinks", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.work, "outside.txt"), "outside this app");
  fs.symlinkSync(path.join(f.work, "outside.txt"), path.join(f.project, "escape.txt"));
  assert.equal((await f.request("/escape.txt")).status, 404);
  assert.equal((await f.request("/..%2foutside.txt")).status, 404);
  assert.equal((await f.request("/missing.js")).status, 404);
  assert.equal((await f.request("/")).status, 200);
});

test("requests cannot write the project, choose a root, or access control routes", async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(path.join(f.project, "app.js"));
  assert.equal((await f.request("/app.js", { method: "POST", body: "changed" })).status, 405);
  assert.deepEqual(fs.readFileSync(path.join(f.project, "app.js")), before);
  assert.equal((await f.request("/app.js?root=/elsewhere")).status, 200);
  for (const path of [
    "/api/files/write",
    "/api/signin/start",
    "/api/collab/act",
    "/api/support-access",
  ]) {
    const r = await fetch(f.base + path);
    assert.equal(r.status, 404);
  }
});

test("encoded separators, NUL, bad escapes, folders and a symlinked folder that leads out are refused", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.work, "secrets"));
  fs.writeFileSync(path.join(f.work, "secrets", "key.txt"), "outside");
  fs.symlinkSync(path.join(f.work, "secrets"), path.join(f.project, "linked"));
  fs.mkdirSync(path.join(f.project, "sub"));
  fs.writeFileSync(path.join(f.project, "sub", "ok.txt"), "inside");
  assert.equal((await f.request("/linked/key.txt")).status, 404);
  assert.equal((await f.request("/..%5coutside.txt")).status, 404);
  assert.equal((await f.request("/app.js%00.txt")).status, 404);
  assert.equal((await f.request("/%E0%A4%A")).status, 400);
  assert.equal((await f.request("/sub/")).status, 404, "a folder is never listed");
  assert.equal(await (await f.request("/sub/ok.txt")).text(), "inside");
  const root = await fetch(f.base + "/?x=1", { redirect: "manual" });
  assert.equal(root.status, 308);
  assert.equal(root.headers.get("location"), "/project-apps/checklist/?x=1");
  assert.equal((await fetch(f.base + "/project-apps/other/")).status, 404, "another app's prefix");
  const r = await f.request("/style.css");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-type"), "text/css");
});
