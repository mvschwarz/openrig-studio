import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const delay = (n) => new Promise((r) => setTimeout(r, n));
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
}
function fixture(t, { conflict = false, declaredSeed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-public-")),
    studio = path.join(root, "studio"),
    apps = path.join(root, "apps"),
    project = path.join(root, "project"),
    pids = path.join(root, "pids");
  fs.mkdirSync(project);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  write(path.join(studio, "surfaces.json"), { chatSeats: [] });
  const names = conflict ? ["first", "second"] : ["first"];
  for (const name of names) {
    write(path.join(apps, "apps", name, "app.json"), {
      id: name,
      name,
      surface: { path: "/surfaces/" + name + ".html", entry: "index.html" },
      provider: { package: "@example/" + name, required: true },
      vendor: ["sample"],
    });
    write(path.join(apps, "apps", name, "index.html"), "<h1>Fixture " + name + "</h1>");
    write(path.join(apps, "apps", name, "vendor/sample/entry.mjs"), "export const answer = 42;");
    write(path.join(apps, "providers", name, "provider.json"), {
      package: "@example/" + name,
      run: { entry: "server.mjs", args: ["--port", "{{port}}"] },
      verbs: ["/api/shared"],
      ...(declaredSeed
        ? { seeds: { root: "project", marker: "created.json", entry: "seed.mjs" } }
        : {}),
    });
    write(
      path.join(apps, "providers", name, "server.mjs"),
      `import fs from'node:fs';import http from'node:http';fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');http.createServer((q,s)=>s.end('fixture')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1')`,
    );
    write(
      path.join(apps, "providers", name, "seed.mjs"),
      "import fs from'node:fs';import path from'node:path';export default function(n,{parent}){const p=path.join(parent,n);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'created.json'),'once')}",
    );
  }
  // An unselected legacy provider must never initialize somebody else's project.
  write(
    path.join(apps, "providers/studio-video/video-new.mjs"),
    "import fs from'node:fs';import path from'node:path';export function scaffoldBundle(n,{parent}){const p=path.join(parent,n);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'timeline.json'),'not selected')}",
  );
  const children = [];
  t.after(async () => {
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
    await delay(40);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    studio,
    apps,
    project,
    pids,
    async start(extra = {}) {
      write(path.join(studio, "studio.json"), {
        port: 0,
        appsRoot: apps,
        apps: names,
        roots: { project },
        ...extra,
      });
      const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
        env: { PATH: bin, OPENRIG_STUDIO_DIR: studio },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(c);
      let log = "",
        port = null;
      c.stdout.on("data", (b) => {
        log += b;
        port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
      });
      c.stderr.on("data", (b) => (log += b));
      const exited = new Promise((r) => c.once("exit", (code) => r(code)));
      return {
        c,
        get port() {
          return port;
        },
        exited,
        log: () => log,
        async ready() {
          for (let i = 0; i < 100; i++) {
            if (c.exitCode !== null) throw Error(log);
            if (!port) {
              await delay(40);
              continue;
            }
            try {
              const r = await fetch("http://127.0.0.1:" + port + "/vendor/sample/entry.mjs");
              if (r.status === 200) {
                const c = await fetch("http://127.0.0.1:" + port + "/api/contract");
                if (c.ok && (await c.json()).runtime) return r;
              }
            } catch {}
            await delay(40);
          }
          throw Error(log);
        },
        async stop() {
          c.kill("SIGTERM");
          await exited;
          await delay(80);
        },
      };
    },
  };
}

test("public vendored modules have JavaScript MIME and revalidate after edits", async (t) => {
  const f = fixture(t),
    s = await f.start(),
    r = await s.ready();
  assert.match(r.headers.get("content-type") || "", /javascript/);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.match(await r.text(), /answer = 42/);
  const tag = r.headers.get("etag");
  assert.ok(tag);
  const next = await fetch("http://127.0.0.1:" + s.port + "/vendor/sample/entry.mjs", {
    headers: { "if-none-match": tag },
  });
  assert.equal(next.status, 304);
  await s.stop();
});
test("ordinary project binding never runs an unselected legacy video seeder", async (t) => {
  const f = fixture(t),
    s = await f.start();
  await s.ready();
  assert.deepEqual(fs.readdirSync(f.project), []);
  await s.stop();
});
test("failed composition ends its own providers and preserves a pre-existing service", async (t) => {
  const f = fixture(t, { conflict: true }),
    control = http.createServer((q, r) => r.end("pre-existing"));
  await new Promise((r) => control.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => control.close(r)));
  const s = await f.start();
  assert.equal(await s.exited, 1);
  await delay(200);
  const pids = fs.existsSync(f.pids)
    ? fs.readFileSync(f.pids, "utf8").trim().split(/\s+/).map(Number)
    : [];
  for (const p of pids) {
    assert.throws(() => process.kill(p, 0), /ESRCH/, "startup left child " + p);
  }
  assert.match(s.log(), /two providers claim/);
  assert.equal(
    await (await fetch("http://127.0.0.1:" + control.address().port)).text(),
    "pre-existing",
  );
});
test("declared initialization is once-only and keeps an intentional marker deletion across restart", async (t) => {
  const f = fixture(t, { declaredSeed: true }),
    s = await f.start();
  await s.ready();
  assert.equal(fs.readFileSync(path.join(f.project, "created.json"), "utf8"), "once");
  await s.stop();
  fs.unlinkSync(path.join(f.project, "created.json"));
  const again = await f.start();
  await again.ready();
  assert.deepEqual(fs.readdirSync(f.project), []);
  await again.stop();
});

test("a workspace without generated state never presents the bundled sample as live", async (t) => {
  const f = fixture(t),
    s = await f.start();
  await s.ready();
  const state = await (await fetch("http://127.0.0.1:" + s.port + "/api/factory/state")).json();
  assert.equal(state.ok, false);
  assert.equal(state.mode, "workspace");
  assert.deepEqual(state.seats, []);
  assert.match(state.degraded, /Workspace state is unavailable/);
  const c = await (await fetch("http://127.0.0.1:" + s.port + "/api/contract")).json();
  assert.equal(c.runtime.flavor, "workspace");
  await s.stop();
});
test("demo is explicit and its state names example data", async (t) => {
  const f = fixture(t),
    s = await f.start({ mode: "demo" });
  await s.ready();
  const state = await (await fetch("http://127.0.0.1:" + s.port + "/api/factory/state")).json();
  assert.equal(state.mode, "demo");
  assert.equal(state.fixture, "Example data");
  assert.equal(state.ok, true);
  await s.stop();
});
