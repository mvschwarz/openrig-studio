// A studio with no source of rig state never serves the shipped demo fixture as its rig. A real studio booted by tools/studio.mjs
// with no generating provider and no declared fixtures answers /api/factory/state as unavailable in workspace mode, and labels the
// example data in demo mode; the Floor says which. And a Floor whose last answer said "not attached" stays marked down while the
// change stream opens, fails or falls back to polling.
//
// The booted checks read only the HTTP answer, so on an SDK that serves the fixture as a rig they fail on "fixture-rig" itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO_MJS = path.join(REPO, "tools", "studio.mjs");
const SURFACE = fs.readFileSync(path.join(REPO, "app", "surfaces", "floor.html"), "utf8");

let nextPort = 21600; // clear of the other booted files that run beside this one (19740 … 21340)
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
async function boot(t, studio = {}, prepare = () => {}) {
  const port = nextPort;
  nextPort += 10;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-nc-"));
  const files = path.join(dir, "files");
  fs.mkdirSync(files);
  prepare(dir);
  fs.writeFileSync(
    path.join(dir, "studio.json"),
    JSON.stringify({ port, apps: [], roots: { files }, ...studio }),
  );
  const proc = spawn(process.execPath, [STUDIO_MJS, "--port", String(port)], {
    cwd: dir,
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: dir, OPENRIG_STUDIO_DIR: dir },
  });
  t.after(
    () =>
      new Promise((r) => {
        if (proc.exitCode !== null) return r();
        proc.once("exit", r);
        proc.kill();
      }),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 150; i++) {
    if (
      (await listening(port)) &&
      (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.status === 200
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return `http://127.0.0.1:${port}`;
}

test("CONTROL: no state source, workspace mode: /api/factory/state is unavailable with the way to fix it, never the demo fixture's rig", async (t) => {
  const base = await boot(t);
  const s = await (await fetch(base + "/api/factory/state")).json();
  assert.notEqual(s.rig, "fixture-rig", "the invented demo rig");
  assert.equal(s.ok, false);
  assert.equal(s.rig, null);
  assert.match(s.degraded, /Enable a provider that supplies rig state/);
  assert.deepEqual([s.seats, s.queue], [[], []], "no invented seats or work");
});

test("demo mode: the example data is labelled as such", async (t) => {
  const base = await boot(t, { mode: "demo" });
  const s = await (await fetch(base + "/api/factory/state")).json();
  assert.equal(s.mode, "demo");
  assert.equal(s.fixture, "Example data");
});

test("a studio that declares its own fixtures still gets them (an explicit choice, not a fallback)", async (t) => {
  const base = await boot(t, { fixtures: "./myfixtures" }, (dir) => {
    fs.mkdirSync(path.join(dir, "myfixtures"));
    fs.writeFileSync(
      path.join(dir, "myfixtures", "factory-state.json"),
      JSON.stringify({ rig: "declared-demo", seats: [], queue: [] }),
    );
  });
  const s = await (await fetch(base + "/api/factory/state")).json();
  assert.equal(s.rig, "declared-demo");
});

// The change stream's lifecycle (open, error, polling fallback) must not repaint a known not-attached Floor as live or polling. Run
// as the page runs: the surface's own script in a vm with just enough of a page, the state read held open so the stream opens
// before it settles.
import vm from "node:vm";
const NC = {
  ok: true,
  rig: null,
  generatedAt: "2026-10-25T11:40:00.000Z",
  attached: false,
  reason: "no-rig",
  detail: null,
  seats: [],
  queue: [],
};
const ATTACHED = {
  ok: true,
  rig: "lab",
  generatedAt: "2026-10-25T11:41:00.000Z",
  attached: true,
  seats: [],
  queue: [],
};
function page(states) {
  const script = SURFACE.match(/<script>([\s\S]*)<\/script>/)[1];
  const el = () => ({
    innerHTML: "",
    textContent: "",
    value: "",
    className: "",
    lastElementChild: { textContent: "" },
    hidden: false,
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
  });
  const els = Object.fromEntries(
    [
      "#content",
      "#rig",
      "#updated",
      "#connection",
      "#find",
      "#found",
      "#findbox",
      "#nomatch-open",
      "#nomatch-done",
      ".eyebrow",
    ].map((s) => [s, el()]),
  );
  const sources = [],
    held = [];
  let reads = 0;
  const ctx = {
    document: { querySelector: (s) => els[s] },
    console,
    parent: { postMessage() {} },
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    localStorage: { getItem: () => null },
    addEventListener() {},
    location: { reload() {} },
    fetch: (url) => {
      if (url === "/api/contract")
        return Promise.resolve({
          json: async () => ({
            contractVersion: "0.1",
            capabilities: ["observe.factory-state", "stream.events"],
          }),
        });
      if (url === "/surfaces.json") return Promise.resolve({ json: async () => ({}) });
      if (url === "/api/files/roots")
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); // a Studio without Files
      if (url === "/api/studio/place")
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); // a Studio without the place route
      const n = reads++;
      if (n === 0) return Promise.resolve({ json: async () => states[0] });
      return new Promise((resolve) =>
        held.push(() => resolve({ json: async () => states[Math.min(n, states.length - 1)] })),
      ); // later reads held
    },
    EventSource: function (url) {
      const s = {
        url,
        close() {},
        addEventListener(t, fn) {
          this["on" + t] = fn;
        },
      };
      sources.push(s);
      return s;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const signal = () => ({
    mode: els["#connection"].className.replace("connection ", ""),
    label: els["#connection"].lastElementChild.textContent,
  });
  return { sources, held, signal };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("CONTROL: a not-attached Floor stays 'not attached' (down) when the change stream opens, errors or falls back to polling", async () => {
  const p = page([NC]);
  await settle();
  assert.deepEqual(p.signal(), { mode: "down", label: "not attached" }, "first answer drawn");
  p.sources[0].onopen(); // the stream opens; its refresh is held, so nothing has re-rendered yet
  assert.deepEqual(
    p.signal(),
    { mode: "down", label: "not attached" },
    "not repainted green by the stream opening",
  );
  p.sources[0].onerror(); // the stream fails: polling fallback
  assert.deepEqual(
    p.signal(),
    { mode: "down", label: "not attached" },
    "not repainted 'polling fallback'",
  );
});

test("once an answer is attached, the stream's own state shows again (live)", async () => {
  const p = page([NC, ATTACHED]);
  await settle();
  p.sources[0].onopen();
  assert.deepEqual(p.signal(), { mode: "down", label: "not attached" });
  p.held.shift()(); // the held read answers: attached
  await settle();
  assert.deepEqual(p.signal(), { mode: "live", label: "live signal" });
});
