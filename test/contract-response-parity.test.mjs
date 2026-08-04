// ONE owner for "the documented /api/contract example and the live response
// agree" — at EVERY level, not at one chosen level.
//
//   node --test 'test/*.test.mjs'
//
// WHY THIS FILE REPLACES THREE. Three separate guards grew up here, each
// comparing one nesting level of the same response against the same document:
// the `runtime` block, the `manifest` block, and `manifest.consumer`. Each was
// added when a field shipped undocumented at that level, and each was correct
// about its own level.
//
// Nobody owned the TOP level. An undocumented field added beside
// `contractVersion` was invisible to all three, and one of them carried a comment
// promising "add a field without documenting it and this test fails" — which was
// false for the level it did not check. That comment is what makes it worse than
// no guard: it reads as coverage.
//
// A fourth bespoke assertion would have closed the fourth level and left the
// fifth open. So this compares the documented example against the served
// response STRUCTURALLY, descending wherever both sides are objects, and it is
// the only place that comparison lives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const META = fs.readFileSync(path.join(REPO, "contract", "contract-meta.md"), "utf8");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start(withOverlay) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const args = [];
  if (withOverlay) {
    const overlay = path.join(dir, "overlay");
    fs.mkdirSync(overlay);
    fs.writeFileSync(path.join(overlay, "surfaces.json"), JSON.stringify({ surfaces: [] }));
    args.push("--surfaces", overlay);
  }
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port), ...args],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const r = await (await fetch(`http://127.0.0.1:${port}/api/contract`, { cache: "no-store" })).json();
      return { response: r, stop: () => proc.kill() };
    } catch {
      if (Date.now() > deadline) { proc.kill(); throw new Error("runtime never came up"); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const example = (heading) => {
  const m = META.match(new RegExp(`${heading}\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  assert.ok(m, `contract-meta.md no longer carries the example after: ${heading}`);
  return JSON.parse(m[1]);
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Descend wherever BOTH sides are objects. Values are never compared — they are
// timestamps and counts and would differ by design — only the shape is.
function divergences(documented, live, at = "response", out = []) {
  if ((documented === null) !== (live === null)) {
    out.push(`${at}: documented as ${documented === null ? "null" : "an object"} but served as ` +
      `${live === null ? "null" : "an object"}`);
    return out;
  }
  if (!isPlainObject(documented) || !isPlainObject(live)) return out;

  const d = Object.keys(documented).sort();
  const l = Object.keys(live).sort();
  const undocumented = l.filter((k) => !d.includes(k));
  const unserved = d.filter((k) => !l.includes(k));
  if (undocumented.length) out.push(`${at}: served but NOT documented — ${undocumented.join(", ")}`);
  if (unserved.length) out.push(`${at}: documented but NOT served — ${unserved.join(", ")}`);

  for (const k of d.filter((k) => l.includes(k))) divergences(documented[k], live[k], `${at}.${k}`, out);
  return out;
}

test("positive control: the comparator descends and can report at EVERY level", () => {
  // Without this the whole file passes by comparing nothing — the exact failure
  // it was written to end. Each planted divergence must be reported AT ITS PATH.
  const doc = { a: 1, nest: { b: 2, deep: { c: 3 } }, nulled: null };

  assert.deepEqual(divergences(doc, doc), [], "identical shapes must not diverge");

  const top = divergences(doc, { ...doc, extra: 1 });
  assert.equal(top.length, 1);
  assert.match(top[0], /^response: served but NOT documented — extra$/);

  const nested = divergences(doc, { ...doc, nest: { b: 2, deep: { c: 3 }, sneak: 1 } });
  assert.match(nested[0], /^response\.nest: served but NOT documented — sneak$/);

  const deep = divergences(doc, { ...doc, nest: { b: 2, deep: { c: 3, deeper: 1 } } });
  assert.match(deep[0], /^response\.nest\.deep: served but NOT documented — deeper$/);

  const missing = divergences(doc, { nest: doc.nest, nulled: null });
  assert.match(missing[0], /documented but NOT served — a$/);

  const nulled = divergences(doc, { ...doc, nulled: { now: "an object" } });
  assert.match(nulled[0], /^response\.nulled: documented as null but served as an object$/);
});

test("zero-config: the documented example and the served response agree at every level", async (t) => {
  const s = await start(false);
  t.after(() => s.stop());
  assert.deepEqual(divergences(example("`GET /api/contract` returns:"), s.response), [],
    "the documented /api/contract example and the zero-config response have diverged");
});

test("overlay-configured: the documented consumer example agrees with the served block", async (t) => {
  // The consumer block is null in the main example, so its shape can only be
  // compared against a runtime that actually configures an overlay — which is
  // precisely why it went unguarded long enough for a field to ship there
  // undocumented.
  const s = await start(true);
  t.after(() => s.stop());
  const live = s.response.manifest.consumer;
  assert.ok(live, "positive control: an overlay-configured runtime must report a consumer block");
  assert.deepEqual(
    divergences(example("With an overlay configured, `manifest\\.consumer` is populated:"), live, "manifest.consumer"),
    [],
    "the documented consumer example and the served consumer block have diverged"
  );
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
