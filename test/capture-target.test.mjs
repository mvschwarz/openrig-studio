// Where an app says captures should go — refused at DECLARATION.
//
//   node --test 'test/*.test.mjs'
//
// The ask arrived as `declareCaptureTarget(dir)`, taking a raw directory. That is
// the exact anti-pattern `app-manifest.md` names — "roots are KINDS, never paths…
// works on exactly one machine" — and independently an unbounded write surface: an
// app could name any directory on the box. Raised as a PRD deviation and ruled to
// the kind-bound shape rather than built either way.
//
// The property: a target that cannot be EXPRESSED unsafely cannot be INHERITED
// unsafely by whatever eventually captures. Validation at declaration beats
// validation at write time, because only one of them is impossible to forget.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let nextPort = 9660;

async function start({ roots } = {}) {
  const port = nextPort++;
  const args = [path.join(REPO, "app", "serve-studio.mjs"), "--port", String(port)];
  if (roots) args.push("--roots", JSON.stringify(roots));
  const proc = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/contract`, { cache: "no-store" }); break; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return {
    base,
    stop: () => new Promise((r) => { proc.once("exit", r); proc.kill(); }),
    declare: async (body) => {
      const res = await fetch(`${base}/api/capture-target`, { method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    read: async () => (await fetch(`${base}/api/capture-target`, { cache: "no-store" })).json(),
    contract: async () => (await fetch(`${base}/api/contract`, { cache: "no-store" })).json(),
  };
}

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capt-"));
  fs.mkdirSync(path.join(dir, "feedback", "gateway-m1"), { recursive: true });
  fs.mkdirSync(path.join(dir, "outside", "secret"), { recursive: true });
  return dir;
}

test("a RELATIVE path inside a bound kind resolves", async (t) => {
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "gateway-m1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.target.root, "feedback");
  assert.equal(fs.realpathSync(r.body.target.path), fs.realpathSync(path.join(dir, "feedback", "gateway-m1")));
});

test("a target that does not exist YET is allowed", async (t) => {
  // A slice's feedback/ dir before anything has been captured into it. Refusing
  // here would mean an app can only declare a directory something already created,
  // which inverts the order the app actually works in.
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "slice-99/feedback" });
  assert.equal(r.status, 200, `refused a not-yet-created target: ${r.body.error}`);
});

test("EVERY escape shape is refused", async (t) => {
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  for (const p of ["../outside", "../../etc", "gateway-m1/../../outside", "/etc/passwd", ""]) {
    const r = await s.declare({ root: "feedback", path: p });
    assert.equal(r.status, 400, `'${p}' was ACCEPTED — captures would land outside the root`);
    assert.ok(r.body.error, `'${p}' refused without saying why`);
  }
});

test("a SYMLINK out of the root is refused — containment resolves both sides", async (t) => {
  // The discriminating case. A lexical startsWith follows a symlink straight out
  // and reports success, which is why realpath is on both sides.
  const dir = tree();
  fs.symlinkSync(path.join(dir, "outside"), path.join(dir, "feedback", "escape-link"));
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "escape-link/secret" });
  assert.equal(r.status, 400, "a symlink escaped the root — containment is lexical, not real");
});

test("POSITIVE CONTROL: the legitimate declaration still works alongside those", async (t) => {
  // An over-restrictive boundary and a correct one are indistinguishable under an
  // attack-only test. This repo has shipped that mistake before.
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "gateway-m1" });
  assert.equal(r.status, 200, "the boundary refuses everything, including what it must allow");
});

test("an UNBOUND kind is refused, never silently redirected", async (t) => {
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "media", path: "x" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no root bound/,
    "an unbound kind did not say the kind was the problem");
  // Landing captures somewhere unexpected is worse than not capturing.
  assert.equal((await s.read()).target, null, "a refused declaration still set a target");
});

test("a runtime with NO roots refuses everything and says the kind is unbound", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "x" });
  assert.equal(r.status, 400);
  assert.deepEqual((await s.contract()).capture.roots, []);
});

test("null withdraws the target", async (t) => {
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  await s.declare({ root: "feedback", path: "gateway-m1" });
  assert.ok((await s.read()).target, "nothing was set to withdraw");
  await s.declare(null);
  assert.equal((await s.read()).target, null, "the target survived being withdrawn");
});

test("the contract SAYS nothing consumes it yet", async (t) => {
  // An inert seam that looks wired is the plausible-path-that-does-nothing shape.
  // Reporting consumedBy: null is what makes the interim honest — and it is why
  // this is explicitly NOT lockable until a capture action consumes it end to end.
  const dir = tree();
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  const c = await s.contract();
  assert.equal(c.capture.consumedBy, null,
    "consumedBy claims a consumer — if a capture action now exists, this is lockable and the note must go");
  assert.ok(c.capabilities.includes("capture.target"));
});

test("THIS VERB WRITES NOTHING — the contract still has no write verbs", async (t) => {
  const dir = tree();
  const before = fs.readdirSync(path.join(dir, "feedback"));
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  await s.declare({ root: "feedback", path: "slice-99/feedback" });
  assert.deepEqual(fs.readdirSync(path.join(dir, "feedback")), before,
    "declaring a target created something on disk — this verb records, it does not write");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});

test("MULTI-LOCATION ROOT: existence decides the binding, not order", async (t) => {
  // QA finding. Containment holds for a path that does not exist yet — which must
  // stay allowed — so the FIRST binding swallowed every relative path and later
  // bindings were unreachable even when the target existed there. Accepted-but-
  // misdirected, and this contract's own line is that landing somewhere
  // unexpected is worse than refusing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-"));
  const first = path.join(dir, "first"), second = path.join(dir, "second");
  fs.mkdirSync(path.join(second, "proof", "shot"), { recursive: true });
  fs.mkdirSync(first, { recursive: true });

  const s = await start({ roots: { feedback: [first, second] } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "proof/shot" });
  assert.equal(r.status, 200);
  assert.equal(fs.realpathSync(r.body.target.path), fs.realpathSync(path.join(second, "proof", "shot")),
    "resolved to the first binding where the target does NOT exist, ignoring the one where it does");
  assert.ok(fs.existsSync(r.body.target.path), "resolved to a path that does not exist");
});

test("multi-location: a target existing NOWHERE still resolves, to the first binding", async (t) => {
  // The create-it-later case must keep working; this is the positive control that
  // stops the fix above from becoming "refuse unless it already exists".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-"));
  const first = path.join(dir, "first"), second = path.join(dir, "second");
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second, { recursive: true });
  const s = await start({ roots: { feedback: [first, second] } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "slice-99/feedback" });
  assert.equal(r.status, 200, `refused a not-yet-created target: ${r.body.error}`);
  assert.equal(fs.realpathSync(path.dirname(path.dirname(r.body.target.path))), fs.realpathSync(first));
});

test("multi-location: AMBIGUOUS refuses rather than picking", async (t) => {
  // Existing under two bindings has no honest answer, and choosing silently is the
  // defect this was rewritten for.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-"));
  const first = path.join(dir, "first"), second = path.join(dir, "second");
  fs.mkdirSync(path.join(first, "proof"), { recursive: true });
  fs.mkdirSync(path.join(second, "proof"), { recursive: true });
  const s = await start({ roots: { feedback: [first, second] } });
  t.after(() => s.stop());
  const r = await s.declare({ root: "feedback", path: "proof" });
  assert.equal(r.status, 400, "picked one of two equally valid locations instead of refusing");
  assert.match(r.body.error, /exists under 2 locations/);
});

test("PROTOTYPE-NAMED root kinds 400 like any unbound kind, never 500", async (t) => {
  // Root kinds are an OPEN vocabulary, so `constructor` is a valid spelling. On a
  // plain object it is INHERITED — the lookup answered with Object's constructor
  // and the 400 became a 500. Guarded elsewhere in the SDK already; the newer map
  // reopened it, which is why the primitive is now shared.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-"));
  fs.mkdirSync(path.join(dir, "feedback"), { recursive: true });
  const s = await start({ roots: { feedback: path.join(dir, "feedback") } });
  t.after(() => s.stop());
  for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const r = await s.declare({ root: kind, path: "x" });
    assert.equal(r.status, 400, `'${kind}' did not 400 — an inherited key answered the lookup`);
    assert.match(r.body.error, /no root bound/, `'${kind}' 400'd for the wrong reason`);
  }
  // positive control: a real kind still resolves
  assert.equal((await s.declare({ root: "feedback", path: "ok" })).status, 200);
});
