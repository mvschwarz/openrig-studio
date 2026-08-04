// Controls for the change signal: the marker, the process identity, and the
// helper the runtime serves.
//
//   node --test 'test/*.test.mjs'
//
// The design decisions these pin, each of which had an alternative:
//   * the marker is NORMATIVE and the transport is not, so a surface that only
//     polls is fully conformant and nothing is required to implement SSE;
//   * a CODE change is keyed on the runtime's process identity, not on a file
//     mtime, because a studio copies surfaces at boot and edited source does not
//     reach a browser until a restart;
//   * that identity is latched on FIRST OBSERVATION rather than on the first
//     SUCCESSFUL poll — latching on success is why a restart straddling startup
//     goes undetected in the implementation this replaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { cache: "no-store" });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await (await get("/api/contract")).json(); break; }
    catch { if (Date.now() > deadline) { proc.kill(); throw new Error("never came up"); }
            await new Promise((r) => setTimeout(r, 100)); }
  }
  return { dir, port, get, stop: () => proc.kill() };
}

test("the runtime reports a process identity at /api/contract", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const c = await (await s.get("/api/contract")).json();
  assert.equal(typeof c.runtime.boot, "string");
  assert.ok(c.runtime.boot.length >= 8, `boot id too short to be distinguishing: ${c.runtime.boot}`);
});

test("the identity is STABLE across reads — it marks the process, not the request", async (t) => {
  // The discriminating half. A value that changed per request would satisfy
  // "there is a boot id" and make every poll look like a restart.
  const s = await start();
  t.after(() => s.stop());
  const a = (await (await s.get("/api/contract")).json()).runtime.boot;
  await new Promise((r) => setTimeout(r, 60));
  const b = (await (await s.get("/api/contract")).json()).runtime.boot;
  // Assert it EXISTS before asserting it is unchanged. The first version of this
  // compared two undefineds and passed against a runtime with no boot id at all
  // — a control that agrees when the feature is absent is not a control.
  assert.equal(typeof a, "string", "no boot id to be stable");
  assert.equal(a, b, "the boot id changed without a restart");
});

test("a RESTART changes it — so a code change is detectable at all", async (t) => {
  const a = await start();
  const first = (await (await a.get("/api/contract")).json()).runtime.boot;
  a.stop();
  const b = await start();
  t.after(() => b.stop());
  const second = (await (await b.get("/api/contract")).json()).runtime.boot;
  assert.notEqual(first, second, "two separate processes reported the same identity");
});

test("the runtime serves the change-signal helper at a stable path", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const r = await s.get("/signal.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /javascript/);
  const body = await r.text();
  assert.match(body, /export function watchSignal/, "the helper does not export the documented entry point");
});

test("the documented /api/contract runtime block matches what is served", async (t) => {
  // Same descent the consumer block already has. `runtime` gained a field, and
  // the top-level guard compares manifest keys only — so without this, a field
  // could ship there undocumented exactly as `consumer.dir` once did.
  const s = await start();
  t.after(() => s.stop());
  const doc = fs.readFileSync(path.join(REPO, "contract", "contract-meta.md"), "utf8");
  const block = doc.match(/`GET \/api\/contract` returns:\n\n```json\n([\s\S]*?)\n```/);
  assert.ok(block, "the /api/contract example is gone");
  const documented = JSON.parse(block[1]);
  const live = (await (await s.get("/api/contract")).json()).runtime;
  assert.deepEqual(Object.keys(documented.runtime).sort(), Object.keys(live).sort(),
    "the documented runtime block and the served one have diverged");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
