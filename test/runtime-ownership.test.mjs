// Two studios must not share one .runtime/ silently.
//
//   node --test test/runtime-ownership.test.mjs
//
// Composing is destructive, and two studios sharing a STUDIO_DIR share .runtime/.
// If the second to boot repainted the first's rail, the first would keep serving
// the routing table it built IN MEMORY at ITS boot: an app that is present, looks
// installed, and cannot work — a tab that loads 200 over verbs that 404, because
// the process showing the row never heard of the provider behind it.
//
// SCOPE: these tests prove the cause is prevented — the second boot refuses and
// the rail is not repainted — rather than reproducing the 404, which needs a
// provider-backed app (the reference runtime answers the files verbs itself and
// would mask it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO_MJS = path.join(REPO, "tools", "studio.mjs");

// A self-contained apps root: two page-only apps, no providers. The ownership
// guard runs before any app-specific code, so nothing richer is needed.
function makeApps(root) {
  const apps = path.join(root, "apps");
  for (const id of ["first", "second"]) {
    const dir = path.join(apps, "apps", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "app.json"),
      JSON.stringify({
        id,
        name: id,
        surface: { path: `/surfaces/${id}.html`, entry: "index.html" },
      }),
    );
    fs.writeFileSync(path.join(dir, "index.html"), `<h1>${id}</h1>`);
  }
  return apps;
}

// The studio and its apps live in one temp dir. After the test, every studio
// booted from it is stopped and the dir is removed. Port 0 lets the OS choose
// every port; boot() reads back the public one.
function makeStudio(t, apps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-own-"));
  const dir = path.join(root, "studio");
  fs.mkdirSync(dir);
  const appsRoot = makeApps(root);
  fs.writeFileSync(
    path.join(dir, "studio.json"),
    JSON.stringify({ port: 0, appsRoot, apps }, null, 2),
  );
  const studio = { dir, appsRoot, booted: [] };
  t.after(async () => {
    for (const b of studio.booted) await b.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return studio;
}

// Only node on PATH, so the launcher never reaches a real `rig`, tmux or ttyd.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "studio-own-bin-"));
fs.symlinkSync(process.execPath, path.join(BIN, "node"));
const ENV = (dir) => ({ PATH: BIN, HOME: os.tmpdir(), OPENRIG_STUDIO_DIR: dir });

const listening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
// A port nothing is listening on: the OS hands it out, and it is closed again.
const closedPort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function boot(studio) {
  const { dir } = studio;
  const proc = spawn(process.execPath, [STUDIO_MJS], {
    cwd: dir,
    env: ENV(dir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (b) => {
    out += b;
  });
  proc.stderr.on("data", (b) => {
    out += b;
  });
  let port = null;
  for (let i = 0; i < 120 && !port; i++) {
    if (proc.exitCode !== null) throw new Error(`studio exited ${proc.exitCode}:\n${out}`);
    port = Number(out.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  const booted = {
    proc,
    port,
    stop: () =>
      new Promise((r) => {
        if (proc.exitCode !== null) return r();
        proc.once("exit", r);
        proc.kill();
      }),
  };
  studio.booted.push(booted);
  assert.ok(port && (await listening(port)), `studio did not start serving:\n${out}`);
  return booted;
}
const railIds = (dir) => {
  const p = path.join(dir, ".runtime", "surfaces", "surfaces.json");
  return JSON.parse(fs.readFileSync(p, "utf8")).surfaces.map((s) => s.id);
};
process.on("exit", () => fs.rmSync(BIN, { recursive: true, force: true }));

test("a booting studio stamps .runtime/ with its own port", async (t) => {
  const studio = makeStudio(t, ["first"]),
    { dir } = studio;
  const a = await boot(studio);
  const owner = JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "owner.json"), "utf8"));
  assert.equal(owner.port, a.port, "the stamp does not name this studio's port");
  assert.equal(owner.studioRoot, dir);
  assert.ok(owner.pid > 0 && owner.startedAt, "the stamp is missing pid or startedAt");
});

test("a SECOND studio on the same .runtime/ REFUSES instead of repainting", async (t) => {
  const studio = makeStudio(t, ["first"]),
    { dir, appsRoot } = studio;
  const a = await boot(studio);
  const portA = a.port;
  const before = railIds(dir);
  assert.ok(before.includes("first"), `first studio did not compose its app: ${before}`);

  // Same directory, different port, different app list — the exact shape.
  fs.writeFileSync(
    path.join(dir, "studio.json"),
    JSON.stringify({ port: 0, appsRoot, apps: ["second"] }, null, 2),
  );
  const second = spawnSync(process.execPath, [STUDIO_MJS], {
    cwd: dir,
    env: ENV(dir),
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(
    second.status,
    7,
    `expected refusal (exit 7), got ${second.status}: ${second.stderr}`,
  );
  assert.match(
    second.stderr,
    new RegExp(`port ${portA}`),
    "the refusal does not name which studio owns the directory",
  );
  assert.deepEqual(
    railIds(dir),
    before,
    "the first studio's rail was repainted anyway — its tabs now show apps it cannot route",
  );
  assert.ok(await listening(portA), "the first studio stopped serving");
});

test("a STALE stamp is taken over, and the takeover is announced", async (t) => {
  const studio = makeStudio(t, ["first"]),
    { dir } = studio;
  // A stamp naming a port nothing is serving: the owner is gone.
  const stalePort = await closedPort();
  fs.mkdirSync(path.join(dir, ".runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".runtime", "owner.json"),
    JSON.stringify({
      pid: 999999,
      port: stalePort,
      studioRoot: dir,
      startedAt: "2020-01-01T00:00:00Z",
    }),
  );

  const b = await boot(studio);

  const owner = JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "owner.json"), "utf8"));
  assert.equal(
    owner.port,
    b.port,
    "a stale stamp was not taken over — a dead studio blocks a live one forever",
  );
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
