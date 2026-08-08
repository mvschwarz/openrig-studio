// A provider cannot capture a verb that answers the runtime's own state — and the
// mechanism that guarantees it must reach the NEXT verb, not just the last one.
//
//   node --test 'test/*.test.mjs'
//
// HISTORY, because it is the reason this file is shaped like this:
//
// A provider declared /api/focus and implemented POST only. The compositor routes
// a declared verb to its provider BEFORE the runtime, so GET /api/focus answered
// 404 while /api/contract went on advertising focus.read. focus and drive were
// reserved and the defect closed.
//
// IT DID NOT GENERALISE. /api/capture-target was added later, nobody remembered
// the second list in tools/studio.mjs, and a one-provider studio 404'd it publicly
// while the runtime answered 200 internally and the contract advertised the
// capability. The guard here MISSED IT because it filtered routes against a
// HARDCODED LIST — a verb nobody added to the list was never checked.
//
// So this file now tests three things, in order of how much they are worth:
//   1. every route is CLASSIFIED — an unclassified one fails (catches the next omission)
//   2. the reserved set is DERIVED, not restated (removes the second list)
//   3. the two directions still hold (reserving too much is as wrong as too little)

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_OWNED_VERBS, SUBSTITUTABLE_VERBS, openVocabMap, lookup } from "../app/verbs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

// Every /api route the runtime actually serves, read out of the runtime.
const routedVerbs = () => {
  const src = read("app", "serve-studio.mjs");
  return [...new Set([...src.matchAll(/u\.pathname === "(\/api\/[a-z/-]+)"/g)].map((m) => m[1]))];
};

test("positive control: routes and classifications both parse and are non-empty", () => {
  assert.ok(routedVerbs().length >= 6, `parsed ${routedVerbs().length} routes`);
  assert.ok(RUNTIME_OWNED_VERBS.length >= 5);
  assert.ok(SUBSTITUTABLE_VERBS.length >= 4);
});

test("EVERY served verb is classified — this is the check that catches the NEXT omission", () => {
  // The one that would have caught capture-target. A new route must be declared
  // runtime-owned or substitutable; there is no third state and no default, so a
  // verb cannot be added while the decision is skipped.
  const classified = new Set([...RUNTIME_OWNED_VERBS, ...SUBSTITUTABLE_VERBS]);
  const unclassified = routedVerbs().filter((v) => !classified.has(v));
  assert.deepEqual(unclassified, [],
    `these verbs are served but classified in neither list in app/verbs.mjs — ` +
    `an unclassified verb is routed to a provider that never declared it, which is a public 404 ` +
    `over a capability the contract advertises: ${unclassified.join(", ")}`);
});

test("nothing is classified BOTH ways, and nothing classified is unserved", () => {
  const both = RUNTIME_OWNED_VERBS.filter((v) => SUBSTITUTABLE_VERBS.includes(v));
  assert.deepEqual(both, [], `classified as both owned and substitutable: ${both.join(", ")}`);
  const served = new Set(routedVerbs());
  const phantom = [...RUNTIME_OWNED_VERBS, ...SUBSTITUTABLE_VERBS].filter((v) => !served.has(v));
  assert.deepEqual(phantom, [],
    `classified but not served — the classification has drifted from the routes: ${phantom.join(", ")}`);
});

test("the compositor DERIVES its reserved set rather than restating it", () => {
  // The second list is what broke. tools/studio.mjs must build SDK_OWNED from
  // RUNTIME_OWNED_VERBS, not from a literal — a literal is a list someone has to
  // remember to join, and the last person did not.
  const src = read("tools", "studio.mjs");
  assert.match(src, /import \{[^}]*RUNTIME_OWNED_VERBS[^}]*\} from "\.\.\/app\/verbs\.mjs"/,
    "tools/studio.mjs does not import the shared verb classification");
  assert.match(src, /const SDK_OWNED = new Set\(RUNTIME_OWNED_VERBS\)/,
    "SDK_OWNED is not derived from RUNTIME_OWNED_VERBS — if it is a literal again, the next verb will be missed again");
});

test("the FILES and ANNOTATIONS verbs are NOT reserved — substitution there is the point", () => {
  // The retraction, pinned. In a real studio these should be served by something
  // that knows about real directories and a real annotation store.
  const wrong = ["/api/files/tree", "/api/files/read", "/api/files/raw", "/api/files/search",
    "/api/annotations"].filter((v) => RUNTIME_OWNED_VERBS.includes(v));
  assert.deepEqual(wrong, [],
    `reserving these forbids the substitution that is the point of a provider: ${wrong.join(", ")}`);
});

test("open-vocabulary maps use the shared safe primitive, not a bare object", () => {
  // Root kinds are an open vocabulary, so `constructor` is a valid spelling. On a
  // plain object it is INHERITED, which turned an honest 400 into a 500. This class
  // was already guarded in the SDK's other root-binding code and the newer map
  // reopened it — so the primitive is shared and its use is asserted.
  const src = read("app", "serve-studio.mjs");
  assert.match(src, /openVocabMap\(/, "the runtime no longer builds its open-vocabulary map with the shared primitive");
  assert.match(src, /lookup\(BOUND_ROOTS,/, "BOUND_ROOTS is read without the own-property lookup");
  assert.doesNotMatch(src, /BOUND_ROOTS\[[a-z]/,
    "BOUND_ROOTS is indexed directly somewhere — an inherited key would answer");
});

test("the safe primitive actually resists prototype keys", () => {
  // Assert the primitive's behaviour, not only that it is called.
  const m = openVocabMap([["feedback", ["/tmp/x"]]]);
  assert.equal(lookup(m, "feedback")[0], "/tmp/x");
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(lookup(m, k), undefined, `lookup returned something for the inherited key '${k}'`);
  }
});

test("positive control: the classification check can fail", () => {
  // Plant an unclassified route and confirm the check catches it — otherwise the
  // assertion above is a check that has only ever been seen to pass.
  const classified = new Set([...RUNTIME_OWNED_VERBS, ...SUBSTITUTABLE_VERBS]);
  const planted = [...routedVerbs(), "/api/newly-added-verb"];
  const missed = planted.filter((v) => !classified.has(v));
  assert.deepEqual(missed, ["/api/newly-added-verb"],
    "an unclassified route was not detected, so the guard would not catch the next omission either");
});

test("the compositor consults SDK_OWNED BEFORE the sole-provider fallthrough", () => {
  // The mechanism that turns the classification into behaviour. The fallthrough
  // sends any unowned /api/* to `soleProvider` — a provider that never declared
  // the verb — so a one-provider studio publicly 404s a verb the runtime answers
  // internally. That guard must sit in front of it, not beside it.
  const src = read("tools", "studio.mjs");
  const m = src.match(/if \(url\.pathname\.startsWith\("\/api\/"\)[^\n]*\n[^\n]*\n[^\n]*\n/);
  assert.ok(m, "the /api fallthrough is gone or reshaped — re-read it before trusting this test");
  assert.match(m[0], /!SDK_OWNED\.has\(url\.pathname\)/,
    "the sole-provider fallthrough no longer excludes reserved verbs — a runtime-owned verb would be proxied away");
  assert.match(m[0], /soleProvider/, "the fallthrough this guards is gone; the guard may be guarding nothing");
});

test("STANDING METHOD, recorded so it is not re-derived: prove SDK verbs on a SINGLE-PROVIDER studio", () => {
  // PM made this the bar after a multi-provider dev box masked the routing defect
  // entirely: an advertised verb 200s internally and 404s publicly, and a rich
  // surface looks fine. A one-provider composition plus a public-vs-internal port
  // check is what exposed it.
  //
  // It cannot be asserted from here — tools/studio.mjs is a script with no exports
  // and composing a studio is proof work, not unit work. This test exists so the
  // METHOD is committed next to the mechanism rather than living only in a report.
  const doc = read("contract", "runtime-api.md");
  assert.match(doc, /single-provider/i,
    "runtime-api.md no longer records that SDK verbs are proven on a single-provider composition");
});
