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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { RUNTIME_OWNED_VERBS, SUBSTITUTABLE_VERBS, openVocabMap, lookup,
         discoverApiRoutes, verbMatches, isRuntimeOwned } from "../app/verbs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), "utf8");

// THE ROUTES COME FROM THE RUNNING RUNTIME, not from reading the file.
//
// PM's bar: classification must operate on the ACTUAL served-route set, derived
// from the SAME routing table the runtime serves from and speaking its own
// grammar — not a regex approximation of it. Every `/api` arm goes through
// `serves()`, which matches AND registers, and the chain is walked once at boot so
// the set is COMPLETE rather than "whatever has been hit so far".
// `/api/contract` reports it as `runtime.routes`.
//
// This replaced a source-scanning regex, and the replacement immediately proved
// the point: rewriting the arms to `serves(u.pathname, "…")` made the old
// `u.pathname === "…"` scanner return almost nothing while every route still
// served. An approximation of the router agrees with it only until the router is
// edited.
async function servedRoutes() {
  const port = 9700 + Math.floor(Math.random() * 250);
  const proc = spawn(process.execPath,
    [path.join(REPO, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (let i = 0; i < 120; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/contract`, { cache: "no-store" }); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    const c = await (await fetch(`http://127.0.0.1:${port}/api/contract`, { cache: "no-store" })).json();
    return c.runtime.routes;
  } finally { proc.kill(); }
}

test("positive control: the RUNTIME reports its routes and the classification is non-empty", async () => {
  const routes = await servedRoutes();
  assert.ok(routes.length >= 6, `the runtime reported ${routes.length} routes`);
  assert.ok(RUNTIME_OWNED_VERBS.length >= 5);
  assert.ok(SUBSTITUTABLE_VERBS.length >= 4);
});

test("EVERY served verb is classified, from the RUNTIME account of its own routes", async () => {
  // The one that would have caught capture-target. A new route must be declared
  // runtime-owned or substitutable; there is no third state and no default, so a
  // verb cannot be added while the decision is skipped.
  const classified = new Set([...RUNTIME_OWNED_VERBS, ...SUBSTITUTABLE_VERBS]);
  const unclassified = (await servedRoutes()).filter((v) => !classified.has(v));
  assert.deepEqual(unclassified, [],
    `these verbs are served but classified in neither list in app/verbs.mjs — ` +
    `an unclassified verb is routed to a provider that never declared it, which is a public 404 ` +
    `over a capability the contract advertises: ${unclassified.join(", ")}`);
});

test("nothing is classified BOTH ways, and nothing classified is unserved", async () => {
  const both = RUNTIME_OWNED_VERBS.filter((v) => SUBSTITUTABLE_VERBS.includes(v));
  assert.deepEqual(both, [], `classified as both owned and substitutable: ${both.join(", ")}`);
  const served = new Set(await servedRoutes());
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

test("CONTROL: a LIVE unclassified route of EACH served form is caught", async () => {
  // ⛔ THE CONTROL THAT USED TO BE HERE FIRED ON THE WRONG STAGE OF THE PIPELINE.
  // It appended a string to the SCANNER'S RESULT, proving the set subtraction could
  // fail and proving nothing about whether discovery sees the forms the runtime
  // serves. sdk-qa planted a live `startsWith("/api/qa-added-prefix/")` route: it
  // answered 200 while the suite passed 10/10, because a route the scanner cannot
  // see is a route the classifier is never asked about.
  //
  // So this plants BOTH FORMS into a real runtime, BOOTS it, and asserts the
  // runtime's own reported route set contains them and the classifier rejects them.
  // Nothing here is scanned; the routes are live and answering.
  const src = read("app", "serve-studio.mjs");
  const marker = 'if (serves(u.pathname, "/api/contract")) {';
  assert.ok(src.includes(marker), "the contract arm moved — re-anchor this control before trusting it");
  const planted = src.replace(marker,
    'if (serves(u.pathname, "/api/qa-exact-probe")) return sendJson(res, 200, { ok: true });\n' +
    '    if (serves(u.pathname, "/api/qa-prefix-probe/")) return sendJson(res, 200, { ok: true });\n' +
    '    ' + marker);
  assert.notEqual(planted, src, "the plant did not apply — every result below would be meaningless");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-ctl-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "serve-studio.mjs"), planted);

  const port = 9960 + Math.floor(Math.random() * 30);
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (let i = 0; i < 120; i++) {
      try { await fetch(`http://127.0.0.1:${port}/api/contract`, { cache: "no-store" }); break; }
      catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    // VERIFY THE PLANT IS LIVE, not merely present in the file. A planted route
    // that does not answer would make the rest of this control vacuous.
    const exact = await fetch(`http://127.0.0.1:${port}/api/qa-exact-probe`, { cache: "no-store" });
    const prefix = await fetch(`http://127.0.0.1:${port}/api/qa-prefix-probe/control`, { cache: "no-store" });
    assert.equal(exact.status, 200, "the planted EXACT route does not answer — the control proves nothing");
    assert.equal(prefix.status, 200, "the planted PREFIX route does not answer — this is sdk-qa's exact case");

    const c = await (await fetch(`http://127.0.0.1:${port}/api/contract`, { cache: "no-store" })).json();
    const classified = new Set([...RUNTIME_OWNED_VERBS, ...SUBSTITUTABLE_VERBS]);
    const unclassified = c.runtime.routes.filter((v) => !classified.has(v));
    assert.deepEqual(unclassified.sort(), ["/api/qa-exact-probe", "/api/qa-prefix-probe/"],
      "a LIVE unclassified route was not reported by the runtime — the guard cannot see the form it most needs to catch");
  } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a PREFIX verb is matched as a prefix, and an exact verb is not", () => {
  // The routing half. `/api/export-status/` matching `/api/export-status/42` is the
  // rule the provider verb vocabulary already uses; an exact-only reservation check
  // cannot express it, which is how a parameterized runtime verb would fall through.
  assert.equal(verbMatches("/api/export-status/", "/api/export-status/42"), true);
  assert.equal(verbMatches("/api/focus", "/api/focus"), true);
  assert.equal(verbMatches("/api/focus", "/api/focus-other"), false,
    "an exact verb matched a longer path — that would reserve verbs nobody declared");
  assert.equal(isRuntimeOwned("/api/annotations"), false,
    "a substitutable verb is being treated as runtime-owned");
});

test("the compositor consults SDK_OWNED BEFORE the sole-provider fallthrough", () => {
  // The mechanism that turns the classification into behaviour. The fallthrough
  // sends any unowned /api/* to `soleProvider` — a provider that never declared
  // the verb — so a one-provider studio publicly 404s a verb the runtime answers
  // internally. That guard must sit in front of it, not beside it.
  const src = read("tools", "studio.mjs");
  const m = src.match(/if \(url\.pathname\.startsWith\("\/api\/"\)[^\n]*\n[^\n]*\n[^\n]*\n/);
  assert.ok(m, "the /api fallthrough is gone or reshaped — re-read it before trusting this test");
  assert.match(m[0], /!isRuntimeOwned\(url\.pathname\)/,
    "the fallthrough no longer excludes reserved verbs, or reverted to an EXACT Set.has() — " +
    "an exact check cannot express a parameterized runtime verb and would proxy it away");
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
