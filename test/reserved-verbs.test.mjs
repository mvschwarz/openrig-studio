// A provider cannot capture a verb that answers the runtime's own state.
//
//   node --test 'test/*.test.mjs'
//
// THE FAILURE THIS PINS HAPPENED ON A REAL BOX. A provider declared /api/focus in
// its verbs and implemented POST only. The compositor routes a declared verb to
// its provider BEFORE the runtime, so the provider captured both methods and
// GET /api/focus answered 404 — while GET /api/contract went on advertising
// focus.read, because the runtime declares the capability and cannot see that its
// route was taken. An agent doing feature detection was told the capability was
// there and then met a 404. /api/drive reached the runtime only because no
// provider happened to claim it.
//
// THE TEST FOR MEMBERSHIP IS WHOSE STATE THE VERB ANSWERS, and it is written down
// because I got it wrong in the other direction first: asked whether the FILES
// verbs belonged here I said yes, then retracted it. Files are DIRECTORIES ON THE
// BOX — in a real studio they SHOULD be served by something that knows about real
// directories, and reserving them would have forbidden the correct thing.
//
// So this asserts BOTH directions. Reserving too much is as wrong as reserving too
// little, and only one of those gets noticed by the person it blocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const reserved = () => {
  const src = fs.readFileSync(path.join(REPO, "tools", "studio.mjs"), "utf8");
  const m = src.match(/const SDK_OWNED = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "tools/studio.mjs no longer declares SDK_OWNED — this test cannot find what it checks");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

// Verbs whose state lives IN THE RUNTIME PROCESS. Read out of the runtime rather
// than listed here, so adding one and forgetting to reserve it fails.
const inProcessVerbs = () => {
  const src = fs.readFileSync(path.join(REPO, "app", "serve-studio.mjs"), "utf8");
  const routed = [...src.matchAll(/u\.pathname === "(\/api\/[a-z/-]+)"/g)].map((m) => m[1]);
  // focus and drive hold their record in module state; the others read fixtures
  // or describe the process.
  return routed.filter((r) => ["/api/focus", "/api/drive", "/api/contract"].includes(r));
};

test("positive control: both lists parse and are non-empty", () => {
  assert.ok(reserved().length >= 3, `parsed ${reserved().length} reserved verbs`);
  assert.ok(inProcessVerbs().length >= 3, `parsed ${inProcessVerbs().length} in-process verbs`);
});

test("every verb answering in-process runtime state is reserved", () => {
  const r = reserved();
  const missing = inProcessVerbs().filter((v) => !r.includes(v));
  assert.deepEqual(missing, [],
    `these verbs answer state held in the runtime process, so a provider declaring them captures ` +
    `state nothing else can hold — and the runtime keeps advertising the capability while the route ` +
    `404s: ${missing.join(", ")}`);
});

test("the FILES verbs are NOT reserved — substitution there is the point", () => {
  // The retraction, pinned. In a real studio the files verbs should be served by
  // something that knows about real directories rather than this runtime's
  // fixtures. Reserving them would forbid the correct thing, and nobody would
  // notice until someone tried it.
  const r = reserved();
  const wronglyReserved = ["/api/files/tree", "/api/files/read", "/api/files/raw", "/api/files/search"]
    .filter((v) => r.includes(v));
  assert.deepEqual(wronglyReserved, [],
    `the files verbs answer DIRECTORIES ON THE BOX, not runtime state — reserving them forbids the ` +
    `substitution that is the point of a provider: ${wronglyReserved.join(", ")}`);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
