// Live activation (tools/runtime-extensions.mjs): an app and provider installed, updated or removed while a Studio runs take
// effect without a restart, and the outcome is reported for the registration record's marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activationReport, inspectWorkspace } from "../lib/releases/workspace.mjs";

const SDK = fileURLToPath(new URL("../", import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
async function until(fn, tries = 200) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await wait(50);
  }
  throw last || new Error("timed out");
}
// One app and its provider. The provider answers its verb with its version, its pid, the --state it was given, and whether
// the Studio's per-boot child key guards it (tools/child-key.mjs sets the marker only when the key is active).
function app(root, id, version, { broken = false, state = false } = {}) {
  write(path.join(root, "apps", id, "app.json"), {
    id,
    name: id,
    surface: { path: `/surfaces/${id}.html`, entry: "index.html" },
    provider: { package: "@example/" + id, required: true },
  });
  write(path.join(root, "apps", id, "index.html"), `<h1>${id} ${version}</h1><input id="draft">`);
  write(path.join(root, "providers", id, "provider.json"), {
    package: "@example/" + id,
    run: {
      entry: "server.mjs",
      args: ["--port", "{{port}}", ...(state ? ["--state", "{{state}}"] : [])],
    },
    verbs: [`/api/${id}`],
  });
  write(
    path.join(root, "providers", id, "server.mjs"),
    broken
      ? "invalid syntax !"
      : `import http from 'node:http';const arg=(n)=>process.argv.includes(n)?process.argv[process.argv.indexOf(n)+1]:null;` +
          `http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.statusCode=q.url==='/api/${id}'?200:404;` +
          `s.end(JSON.stringify({version:${JSON.stringify(version)},pid:process.pid,state:arg('--state'),keyed:globalThis[Symbol.for('openrig.studio.childKey')]===true}))})` +
          `.listen(Number(arg('--port')),'127.0.0.1');`,
  );
}
const hashTree = (root) => {
  const lines = [];
  const hash = (b) => createHash("sha256").update(b).digest("hex");
  const walk = (dir, rel = "") => {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name),
        p = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(f, p);
      else if (e.isFile())
        lines.push(`${hash(fs.readFileSync(f))} ${(fs.statSync(f).mode & 0o777).toString(8)} ${p}`);
    }
  };
  walk(root);
  return hash(lines.join("\n"));
};
function boot(t, studio, config) {
  const bin = path.join(path.dirname(studio), "bin");
  fs.mkdirSync(bin, { recursive: true });
  if (!fs.existsSync(path.join(bin, "node")))
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
  write(path.join(studio, "studio.json"), config);
  write(path.join(studio, "surfaces.json"), { chatSeats: [] });
  const child = spawn(process.execPath, [path.join(SDK, "tools/studio.mjs")], {
    env: { PATH: bin, OPENRIG_STUDIO_DIR: studio },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "",
    port = null;
  child.stdout.on("data", (b) => {
    log += b;
    port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
  });
  child.stderr.on("data", (b) => (log += b));
  t.after(async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await wait(80);
  });
  const read = async (route) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`);
    return { status: r.status, body: await r.text() };
  };
  return {
    child,
    read,
    log: () => log,
    get port() {
      return port;
    },
    async first(route) {
      return until(async () => {
        if (child.exitCode !== null) throw new Error(log);
        if (!port) return null;
        const r = await read(route);
        return r.status === 200 && JSON.parse(r.body);
      }).catch((error) => {
        throw new Error(log + "\n" + error.message);
      });
    },
  };
}

test("install, update and removal activate the real surface and provider without restarting the base", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-extensions-")),
    apps = path.join(root, "apps");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    port: 0,
    appsRoot: apps,
    apps: ["base"],
    mode: "workspace",
    roots: { project: path.join(root, "project") },
  };
  app(apps, "base", "base", { state: true });
  const s = boot(t, root, config);
  const base = await s.first("/api/base");
  assert.equal(base.state, path.join(root, ".runtime/state"));
  write(path.join(base.state, "retained.txt"), "keep runtime state");
  const signal = (marker, mounted) => {
    write(path.join(root, "studio.json"), config);
    const file = path.join(root, ".studio-release/extensions.json");
    write(file + ".next", {
      schema: "openrig.extensions-state/v0",
      marker,
      generation: null,
      mounted,
    });
    fs.renameSync(file + ".next", file);
  };
  const baseInventory = ["apps/base", "providers/base"].map((p) => ({
    path: p,
    source: path.join(apps, p),
    contentSha256: hashTree(path.join(apps, p)),
  }));
  const mounted = (version) => [
    ...baseInventory,
    ...["apps/custom", "providers/custom"].map((p) => ({
      path: p,
      source: path.join(apps, p),
      contentSha256: version,
    })),
  ];
  const status = (marker) =>
    until(() => {
      const st = JSON.parse(
        fs.readFileSync(path.join(root, ".runtime/extensions-status.json"), "utf8"),
      );
      return st.marker === marker && st;
    });

  app(apps, "custom", "one");
  const customSpec = path.join(apps, "providers/custom/provider.json");
  const spec = JSON.parse(fs.readFileSync(customSpec, "utf8"));
  spec.seeds = { root: "project", marker: "created.json", entry: "seed.mjs" };
  write(customSpec, spec);
  write(
    path.join(apps, "providers/custom/seed.mjs"),
    "import fs from 'node:fs';import path from 'node:path';export default function(name,{parent}){const root=path.join(parent,name);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'created.json'),'seeded once')}",
  );
  config.apps.push("custom");
  signal("first", mounted("one"));
  assert.equal((await status("first")).state, "active", s.log());
  assert.equal((await s.read("/surfaces/custom.html")).status, 200);
  assert.equal(fs.readFileSync(path.join(root, "project/created.json"), "utf8"), "seeded once");
  fs.unlinkSync(path.join(root, "project/created.json"));
  const first = await s.read("/api/custom");
  assert.equal(first.status, 200);
  const firstProvider = JSON.parse(first.body);
  assert.equal(firstProvider.version, "one");
  const rows = await until(async () => {
    const r = JSON.parse((await s.read("/surfaces.json")).body);
    return r.surfaces.find((x) => x.id === "custom") && r;
  });
  const firstRevision = rows.surfaces.find((x) => x.id === "custom").revision;
  assert.match(firstRevision, /^[a-f0-9]{64}$/);
  assert.match((await s.read("/surfaces/custom.html")).body, /custom one/);

  // A broken update is refused and reported; the running version keeps answering.
  app(apps, "custom", "broken", { broken: true });
  signal("broken", mounted("broken"));
  assert.equal((await status("broken")).state, "failed");
  assert.equal(JSON.parse((await s.read("/api/custom")).body).pid, firstProvider.pid);
  assert.match((await s.read("/surfaces/custom.html")).body, /custom one/);

  app(apps, "custom", "two");
  signal("second", mounted("two"));
  assert.equal((await status("second")).state, "active");
  const second = JSON.parse((await s.read("/api/custom")).body);
  assert.equal(second.version, "two");
  assert.notEqual(second.pid, firstProvider.pid);
  assert.equal(JSON.parse((await s.read("/api/base")).body).pid, base.pid);
  assert.equal(s.child.exitCode, null);
  assert.equal(
    fs.readFileSync(path.join(base.state, "retained.txt"), "utf8"),
    "keep runtime state",
  );
  await until(
    async () =>
      JSON.parse((await s.read("/surfaces.json")).body).surfaces.find((x) => x.id === "custom")
        ?.revision !== firstRevision,
  );
  assert.match((await s.read("/surfaces/custom.html")).body, /custom two/);
  // Seeding runs for a provider's first activation only.
  assert.equal(fs.existsSync(path.join(root, "project/created.json")), false);

  config.apps = ["base"];
  signal("removed", baseInventory);
  assert.equal((await status("removed")).state, "active");
  await until(
    async () =>
      !JSON.parse((await s.read("/surfaces.json")).body).surfaces.some((x) => x.id === "custom"),
  );
  assert.equal((await s.read("/api/custom")).status, 404);
  assert.equal(JSON.parse((await s.read("/api/base")).body).pid, base.pid);
  // The retired provider left supervision for good: it is gone from /healthz and not restarted.
  await wait(1200);
  const health = JSON.parse((await s.read("/healthz")).body);
  assert.equal(health.ok, true, JSON.stringify(health));
  assert.deepEqual(
    health.children.filter((c) => /custom/.test(c.label)),
    [],
    JSON.stringify(health.children),
  );
});

test("an app installed with the installer on a running Studio is live with no restart: supervised, behind the child key, reported active", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-install-live-")),
    studio = path.join(root, "studio"),
    apps = path.join(studio, "apps"),
    src = path.join(root, "src");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  app(apps, "base", "base");
  const config = {
    port: 0,
    appsRoot: apps,
    apps: ["base"],
    roots: { project: path.join(root, "project") },
  };
  const s = boot(t, studio, config);
  const base = await s.first("/api/base");
  const studioPid = s.child.pid;

  // The agent path: the installer copies the app and its provider, enables it, and writes the registration record.
  app(src, "notes", "v1");
  const r = spawnSync(
    process.execPath,
    [
      path.join(SDK, "tools/install-app.mjs"),
      path.join(src, "apps/notes"),
      "--provider",
      path.join(src, "providers/notes"),
      "--enable",
    ],
    { env: { ...process.env, OPENRIG_STUDIO_DIR: studio }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const record = JSON.parse(
    fs.readFileSync(path.join(studio, ".studio-release/extensions.json"), "utf8"),
  );

  // Reported for this record's marker, as the release tools read it.
  const report = await until(() => {
    const a = activationReport(studio);
    return a.state !== "not-reported" && a;
  }).catch((e) => {
    throw new Error(s.log() + "\n" + e.message);
  });
  assert.equal(report.state, "active", s.log());
  assert.equal(report.marker, record.marker);
  // What `studio-release inspect` prints for this unversioned Studio carries the same report.
  const inspected = inspectWorkspace(studio);
  assert.equal(inspected.outcome, "unversioned");
  assert.equal(inspected.extensions?.activation?.state, "active", JSON.stringify(inspected));
  assert.equal(inspected.extensions.activation.marker, record.marker);

  const notes = JSON.parse((await s.read("/api/notes")).body);
  assert.equal(notes.version, "v1");
  assert.equal(notes.keyed, true, "the new provider runs behind the per-boot child key");
  assert.match((await s.read("/surfaces/notes.html")).body, /notes v1/);
  assert.ok(
    JSON.parse((await s.read("/surfaces.json")).body).surfaces.some((x) => x.id === "notes"),
  );
  // Nothing restarted: the Studio and the base provider are the same processes.
  assert.equal(s.child.exitCode, null);
  assert.equal(s.child.pid, studioPid);
  assert.equal(JSON.parse((await s.read("/api/base")).body).pid, base.pid);

  // It is one of the Studio's supervised children, with its port, and that port answers only the Studio.
  const health = JSON.parse((await s.read("/healthz")).body);
  const child = health.children.find(
    (c) => c.kind === "provider" && c.label.startsWith("@example/notes"),
  );
  assert.ok(child, JSON.stringify(health.children));
  assert.equal(child.up, true);
  assert.equal(child.listening, true);
  assert.equal(child.pid, notes.pid);
  const direct = await fetch(`http://127.0.0.1:${child.port}/api/notes`);
  await direct.arrayBuffer();
  assert.equal(direct.status, 403, "reached around the Studio without the child key");
});

test("a registration that comes with a changed shipped SDK or Apps is refused live: restart required, the running apps kept", async (t) => {
  // A release that upgrades the SDK or the Apps changes .studio-release/installed.json; that code is only loaded by a restart,
  // so activation reports failed and changes nothing that runs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-extensions-")),
    apps = path.join(root, "apps");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { port: 0, appsRoot: apps, apps: ["base"], mode: "workspace" };
  const installed = (sdk) =>
    write(path.join(root, ".studio-release/installed.json"), {
      local: {
        studioSdk: { artifact: { sha256: sdk } },
        studioApps: { artifact: { sha256: "apps-1" } },
      },
    });
  installed("sdk-1");
  app(apps, "base", "base");
  const s = boot(t, root, config);
  const before = await s.first("/api/base");

  app(apps, "custom", "one");
  config.apps.push("custom");
  write(path.join(root, "studio.json"), config);
  installed("sdk-2");
  const file = path.join(root, ".studio-release/extensions.json");
  write(file + ".next", {
    schema: "openrig.extensions-state/v0",
    marker: "upgrade",
    generation: null,
    mounted: ["apps/base", "providers/base", "apps/custom", "providers/custom"].map((p) => ({
      path: p,
      source: path.join(apps, p),
      contentSha256: "x",
    })),
  });
  fs.renameSync(file + ".next", file);
  const st = await until(() => {
    const v = JSON.parse(
      fs.readFileSync(path.join(root, ".runtime/extensions-status.json"), "utf8"),
    );
    return v.marker === "upgrade" && v;
  });
  assert.equal(st.state, "failed", s.log());
  assert.match(st.error, /restart is still required/);
  assert.equal((await s.read("/surfaces/custom.html")).status, 404, "the new app isn't served");
  assert.equal((await s.read("/api/custom")).status !== 200, true, "nor its provider");
  const after = JSON.parse((await s.read("/api/base")).body);
  assert.equal(after.pid, before.pid, "the running provider was kept");
  assert.equal(s.child.exitCode, null, "and the Studio still runs");
});

test("an enabled app that can't be composed is left out and reported, as at boot, and never blocks a later live install", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-extensions-")),
    apps = path.join(root, "apps");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // "gone" stays enabled in studio.json after its folder was removed: the boot logs it MISSING and composes the rest.
  const config = { port: 0, appsRoot: apps, apps: ["base", "gone"], mode: "workspace" };
  app(apps, "base", "base");
  const s = boot(t, root, config);
  const before = await s.first("/api/base");
  assert.match(s.log(), /MISSING : gone: no app\.json/);

  app(apps, "custom", "one");
  config.apps.push("custom");
  write(path.join(root, "studio.json"), config);
  const file = path.join(root, ".studio-release/extensions.json");
  write(file + ".next", {
    schema: "openrig.extensions-state/v0",
    marker: "with-stale-entry",
    generation: null,
    // The base keeps its real content hash (unchanged, so it isn't restarted); the new app's is new.
    mounted: ["apps/base", "providers/base", "apps/custom", "providers/custom"].map((p) => ({
      path: p,
      source: path.join(apps, p),
      contentSha256: p.endsWith("base") ? hashTree(path.join(apps, p)) : "x",
    })),
  });
  fs.renameSync(file + ".next", file);
  const st = await until(() => {
    const v = JSON.parse(
      fs.readFileSync(path.join(root, ".runtime/extensions-status.json"), "utf8"),
    );
    return v.marker === "with-stale-entry" && v;
  });
  assert.equal(st.state, "active", s.log());
  assert.deepEqual(st.missing, [`gone: no app.json at ${path.join(apps, "apps", "gone")}`]);
  assert.equal((await s.read("/surfaces/custom.html")).status, 200, "the new app is served");
  assert.equal(JSON.parse((await s.read("/api/custom")).body).version, "one", "and its provider");
  assert.equal(
    JSON.parse((await s.read("/api/base")).body).pid,
    before.pid,
    "the base kept running",
  );
  assert.deepEqual(activationReport(root).missing, st.missing, "studio-release reports it too");
});

test("removing an extension that replaced a shipped provider starts the shipped one live, and the replacement's process goes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-extensions-restore-")),
    apps = path.join(root, "apps");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    port: 0,
    appsRoot: apps,
    apps: ["shipped"],
    mode: "workspace",
    roots: { project: path.join(root, "project") },
  };
  const signal = (marker, mounted) => {
    const file = path.join(root, ".studio-release/extensions.json");
    write(file + ".next", {
      schema: "openrig.extensions-state/v0",
      marker,
      generation: null,
      mounted,
    });
    fs.renameSync(file + ".next", file);
  };
  // The Studio boots with an extension mounted over the shipped app and provider (same package path).
  app(apps, "shipped", "extension");
  signal(
    "boot",
    ["apps/shipped", "providers/shipped"].map((p) => ({
      path: p,
      source: path.join(apps, p),
      contentSha256: "ext",
    })),
  );
  const s = boot(t, root, config);
  const ext = await s.first("/api/shipped");
  assert.equal(ext.version, "extension");
  // Removing it puts the shipped bytes back at the same path (the relink restore) and records no extension.
  app(apps, "shipped", "shipped");
  signal("restored", []);
  const st = await until(() => {
    const x = JSON.parse(
      fs.readFileSync(path.join(root, ".runtime/extensions-status.json"), "utf8"),
    );
    return x.marker === "restored" && x;
  });
  assert.equal(st.state, "active", s.log());
  // The route answers from the shipped provider, a new process; the replacement's process is gone, not left supervised.
  const back = await until(async () => {
    const r = await s.read("/api/shipped");
    return r.status === 200 && JSON.parse(r.body);
  });
  assert.equal(back.version, "shipped");
  assert.notEqual(back.pid, ext.pid);
  await wait(1200);
  let alive = true;
  try {
    process.kill(ext.pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "the removed extension's process was retired");
  const health = JSON.parse((await s.read("/healthz")).body);
  assert.equal(
    health.children.filter((c) => /shipped/.test(c.label)).length,
    1,
    JSON.stringify(health.children),
  );
});
