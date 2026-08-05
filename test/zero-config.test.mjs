// A surface that adopts none of the change signal must behave exactly as it did
// before the change signal existed.
//
//   node --test 'test/*.test.mjs'
//
// The proof contract asks for this to be shown BY A CONTROL RATHER THAN BY
// REASONING, and the difference matters: reasoning about an additive change is
// exactly how the manifest.consumer block came to ship undocumented, and how a
// row field came to be accepted by a schema the runtime then called unknown.
// "It's additive" is a claim about a diff; this measures the behaviour.
//
// So it boots the runtime AS IT WAS before any of this landed, boots the current
// one beside it, and compares what a zero-config consumer actually receives.
//
// The baseline is COMPUTED — the parent of whichever commit added app/signal.js
// — rather than pinned to a SHA that would rot the first time history moves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// The BASELINE comes out of history. The CURRENT side must come out of the
// WORKING TREE, and that distinction is the whole usefulness of this control.
//
// It was written as `git archive HEAD` for both sides, which reads the COMMITTED
// tree — so an uncommitted regression was invisible to it and the control could
// not fail during development, which is the only time it can prevent anything.
// Caught by planting two real zero-config regressions and measuring that they
// existed: the runtime genuinely gained a field and genuinely emitted a warning,
// and this file reported a clean pass through both.
function fromHistory(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeroconf-was-"));
  const tar = spawnSync("git", ["archive", "--format=tar", sha, "app", "fixtures"],
    { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(tar.status, 0, `git archive ${sha} failed: ${tar.stderr}`);
  const out = spawnSync("tar", ["-x", "-C", dir], { input: tar.stdout });
  assert.equal(out.status, 0, `untar failed: ${out.stderr}`);
  return dir;
}

function fromWorkingTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeroconf-now-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  return dir;
}

async function boot(dir) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { cache: "no-store" });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await (await get("/api/contract")).json(); break; }
    catch {
      if (Date.now() > deadline) { proc.kill(); throw new Error(`runtime in ${dir} never came up`); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    json: async (p) => (await get(p)).json(),
    text: async (p) => (await get(p)).text(),
    status: async (p) => (await get(p)).status,
    stop: () => proc.kill(),
  };
}

// The commit that introduced the helper; its parent is "before any of this".
//
// `--diff-filter=A` also matches a RENAME, so if app/signal.js is ever moved this
// resolves to the rename commit and the baseline silently walks forward — a
// weaker comparison that still passes, which is the family of defect this whole
// file keeps meeting. So the property is ASSERTED rather than trusted: whatever
// commit this computes, the helper must not exist there. A walked-forward
// baseline fails loudly instead of quietly comparing the runtime against itself.
const BASELINE = (() => {
  const added = git("log", "--diff-filter=A", "--format=%H", "--", "app/signal.js");
  assert.ok(added, "cannot find the commit that added app/signal.js — this control needs history");
  return git("rev-parse", `${added.split("\n").pop()}^`);
})();

test("the baseline really is BEFORE the helper existed", () => {
  const exists = spawnSync("git", ["cat-file", "-e", `${BASELINE}:app/signal.js`], { cwd: REPO });
  assert.notEqual(exists.status, 0,
    `app/signal.js already exists at the computed baseline ${BASELINE.slice(0, 8)} — the baseline ` +
    `has walked forward (a rename would do this), so every comparison below is weaker than it looks`);
});

test("zero-config: the served rail and its bytes are unchanged from before the change signal", async (t) => {
  const before = await boot(fromHistory(BASELINE));
  t.after(() => before.stop());
  const after = await boot(fromWorkingTree());
  t.after(() => after.stop());

  assert.deepEqual(await after.json("/surfaces.json"), await before.json("/surfaces.json"),
    "the zero-config manifest projection changed");
  assert.equal(await after.text("/surfaces/floor.html"), await before.text("/surfaces/floor.html"),
    "the bytes of the SDK's own surface changed for a consumer who adopted nothing");
});

test("zero-config: the contract answer is additive — one field gained, none lost, version unmoved", async (t) => {
  const before = await boot(fromHistory(BASELINE));
  t.after(() => before.stop());
  const after = await boot(fromWorkingTree());
  t.after(() => after.stop());

  const b = await before.json("/api/contract");
  const a = await after.json("/api/contract");

  // THE TOP-LEVEL KEY SET, and it was missing from the first version of this
  // file. Everything below compared the version, the capabilities, the manifest
  // keys and the runtime block — while a field added at the TOP level of
  // /api/contract sailed through untouched. Measured on a throwaway clone: the
  // runtime served an extra top-level key and this suite reported a clean pass.
  //
  // That is the exact shape named in this file's own rationale — `manifest.
  // consumer` shipping undocumented — so the control did not cover the failure it
  // was written to prevent. The pattern was already here, one block down, applied
  // to `manifest` and not to the response itself.
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(),
    "the /api/contract response gained or lost a TOP-LEVEL field");

  assert.equal(a.contractVersion, b.contractVersion, "contractVersion moved for an additive change");
  // GAINING a capability is additive and is the whole point of the field; LOSING
  // one breaks every consumer that gates on it. This compared them for equality,
  // which reads as strictness and is actually a rule that no feature may ever be
  // advertised — it would have blocked declaring focus and drive.
  // Direction matters and is easy to get backwards: iterate the BASELINE (`b`) and
  // require the CURRENT runtime (`a`) to still carry each. The reverse reads
  // identically and asserts that no capability may ever be ADDED, which is the
  // rule this loop exists to remove.
  for (const cap of b.capabilities) {
    assert.ok(a.capabilities.includes(cap),
      `zero-config LOST capability ${cap} — consumers gate on these, so removal is breaking`);
  }
  assert.deepEqual(Object.keys(a.manifest).sort(), Object.keys(b.manifest).sort(),
    "the manifest report gained or lost a field");

  // The runtime block is where the one intended addition lives. Naming it
  // exactly is what makes this an additive check rather than a vague one: a
  // second field appearing here would fail, and so would `boot` disappearing.
  const gained = Object.keys(a.runtime).filter((k) => !(k in b.runtime));
  const lost = Object.keys(b.runtime).filter((k) => !(k in a.runtime));
  assert.deepEqual(gained, ["boot"], `unexpected addition(s) to the runtime block: ${gained.join(", ")}`);
  assert.deepEqual(lost, [], `the runtime block LOST field(s): ${lost.join(", ")}`);
});

test("zero-config: still no warnings and no errors, which is what 'unchanged' has to mean", async (t) => {
  // A runtime that started warning at a consumer who configured nothing would be
  // a behaviour change even with an identical rail.
  const after = await boot(fromWorkingTree());
  t.after(() => after.stop());
  const m = (await after.json("/api/contract")).manifest;
  assert.deepEqual(m.errors, []);
  assert.deepEqual(m.warnings, [], "a zero-config runtime now emits warnings it did not before");
  assert.equal(m.consumer, null, "the consumer block must stay null with no overlay");
});

test("positive control: the two runtimes ARE different, so the sameness above means something", async (t) => {
  // Without this every assertion above passes trivially if both trees happen to
  // be the same code. The helper is the thing that changed; assert it is absent
  // before and present after.
  const before = await boot(fromHistory(BASELINE));
  t.after(() => before.stop());
  const after = await boot(fromWorkingTree());
  t.after(() => after.stop());

  assert.equal(await before.status("/signal.js"), 404,
    "the baseline already serves the helper — the wrong commit is being compared");
  assert.equal(await after.status("/signal.js"), 200, "the current runtime does not serve the helper");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
