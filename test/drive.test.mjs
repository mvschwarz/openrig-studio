// Controls for drive — the agent operating the surface.
//
//   node --test 'test/*.test.mjs'
//
// The mechanism is a port of one proven in a real application: POST an op, a
// generation counter, latest intent wins, the open page follows. What is asserted
// here is the part a port most easily loses — that superseded intent is DROPPED
// rather than replayed, and that two applications never overlap. Both failures
// leave a surface looking healthy while showing something nobody asked for, which
// is the shape that survives review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driveSurface } from "../app/signal.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await (await fetch(`${base}/api/contract`)).json(); break; }
    catch {
      if (Date.now() > deadline) { proc.kill(); throw new Error("runtime never came up"); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    dir, base,
    drive: async (op) => (await fetch(`${base}/api/drive`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) })).json(),
    read: async (since) => (await fetch(`${base}/api/drive${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`,
      { cache: "no-store" })).json(),
    stop: () => proc.kill(),
  };
}

test("an op posted by an agent is readable by the surface, verbatim", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  await s.drive({ show: "take-3", say: "showing the third take" });
  const got = await s.read();

  assert.equal(got.ok, true);
  assert.equal(got.op.show, "take-3");
  assert.equal(got.op.say, "showing the third take");
});

test("the op is carried OPAQUELY — the runtime imposes no schema on intent", async (t) => {
  // The same decision as surface-typed `selection`, for the same reason: what an
  // op MEANS is the surface's business. A runtime that validated op shapes would
  // be right for one application and would block every other one, and it would
  // quietly become a second renderer.
  const s = await start();
  t.after(() => s.stop());

  const odd = { nested: { deep: [1, 2, { k: "v" }] }, unicode: "café ▲", "weird key": true };
  await s.drive(odd);
  const got = (await s.read()).op;

  for (const [k, v] of Object.entries(odd)) {
    assert.deepEqual(got[k], v, `the runtime altered or dropped an op field it does not understand: ${k}`);
  }
});

test("the marker moves on every op, and NOT otherwise", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  await s.drive({ a: 1 });
  const first = (await s.read()).marker;

  const unchanged = await s.read(first);
  assert.equal(unchanged.changed, false, "the marker moved with no new op");
  assert.equal(unchanged.marker, first);

  await s.drive({ a: 2 });
  const after = await s.read(first);
  assert.equal(after.changed, true, "a new op did not report as a change");
  assert.notEqual(after.marker, first, "the marker did not move for a real op");
});

test("a runtime nobody has driven answers a null op rather than an error", async (t) => {
  // Adopting this must not require anything to have driven the surface first.
  const s = await start();
  t.after(() => s.stop());

  const got = await s.read();
  assert.equal(got.ok, true);
  assert.equal(got.op, null, "an undriven runtime invented an op");
});

test("a malformed op is refused by name rather than silently accepted", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  const arr = await s.drive(["not", "an", "object"]);
  assert.equal(arr.ok, false);
  assert.match(arr.error, /JSON object/);
});

// ------------------------------------------------- the surface half

test("SUPERSEDED OPS ARE DROPPED, not replayed — the whole reason for a counter", async (t) => {
  // THE DEFECT THIS PREVENTS. With a queue, a page that is slow to apply falls
  // behind and then works through instructions that were true minutes ago,
  // animating through states nobody asked to see. It looks healthy the entire
  // time, which is what makes it survive review.
  const applied = [];
  let release;
  const gate = new Promise((r) => { release = r; });

  const d = driveSurface({
    apply: async (op) => { applied.push(op.gen); if (op.gen === 1) await gate; },
    fetchImpl: async () => ({ json: async () => ({ ok: true, changed: false, marker: "x", op: null }) }),
  });
  t.after(() => d.stop());

  d.offer({ gen: 1 });           // starts, and blocks
  d.offer({ gen: 2 });           // superseded before it ever runs
  d.offer({ gen: 3 });           // supersedes 2
  release();
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(applied, [1, 3],
    `every op was applied in order instead of skipping superseded intent: ${applied.join(",")}`);
});

test("an OLDER op arriving late is ignored — order is by generation, not arrival", async (t) => {
  const applied = [];
  const d = driveSurface({
    apply: (op) => { applied.push(op.gen); },
    fetchImpl: async () => ({ json: async () => ({ ok: true, changed: false, marker: "x", op: null }) }),
  });
  t.after(() => d.stop());

  d.offer({ gen: 5 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.offer({ gen: 4 }), "superseded", "an op older than what is applied was accepted");
  assert.equal(d.offer({ gen: 5 }), "superseded", "the same op was applied twice");
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(applied, [5], `a stale or duplicate op was applied: ${applied.join(",")}`);
});

test("two applications never overlap — a mid-flight op waits rather than interleaving", async (t) => {
  // Concurrent applications interleave their writes and leave the surface in a
  // state NEITHER op described. Asserted by measuring overlap directly rather
  // than by trusting the ordering of the results.
  let inFlight = 0, maxConcurrent = 0;
  const d = driveSurface({
    apply: async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
    },
    fetchImpl: async () => ({ json: async () => ({ ok: true, changed: false, marker: "x", op: null }) }),
  });
  t.after(() => d.stop());

  d.offer({ gen: 1 });
  d.offer({ gen: 2 });
  d.offer({ gen: 3 });
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(maxConcurrent, 1, `${maxConcurrent} applications ran at once — they interleave`);
});

test("positive control: the harness CAN observe an overlap", async (t) => {
  // Without this, the assertion above passes against a driver that never applies
  // anything at all — a measurement of nothing reads exactly like a measurement
  // of correct behaviour.
  let inFlight = 0, maxConcurrent = 0;
  const applyOverlapping = async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
  };
  await Promise.all([applyOverlapping(), applyOverlapping()]);
  assert.equal(maxConcurrent, 2, "the overlap detector cannot see concurrency, so the test above proves nothing");
});

test("the poll survives the runtime going away", async (t) => {
  // A surface that stopped polling on the first failed request would need a manual
  // reload to become drivable again — the exact state this primitive removes.
  let calls = 0;
  const d = driveSurface({
    apply: () => {},
    intervalMs: 5,
    fetchImpl: async () => { calls += 1; throw new Error("runtime is down"); },
    onError: () => {},
  });
  t.after(() => d.stop());

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(calls >= 3, `polling stopped after ${calls} failed request(s)`);
});

test("end to end: an agent POSTs and an adopting surface applies it", async (t) => {
  // The claim the whole primitive makes, asserted against the real runtime rather
  // than a scripted transport.
  const s = await start();
  t.after(() => s.stop());

  const applied = [];
  const d = driveSurface({
    apply: (op) => { applied.push(op); },
    endpoint: `${s.base}/api/drive`,
    intervalMs: 20,
  });
  t.after(() => d.stop());

  await s.drive({ show: "take-3" });
  const deadline = Date.now() + 5000;
  while (!applied.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

  assert.equal(applied.length, 1, "the surface never received the op an agent posted");
  assert.equal(applied[0].show, "take-3");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
