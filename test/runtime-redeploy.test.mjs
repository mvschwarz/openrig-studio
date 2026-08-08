// Regression suite for redeploy-survival: the manifest watcher must survive the
// manifest being DELETED AND RECREATED, and the recovery must be OBSERVABLE.
//
//   node --test 'test/*.test.mjs'
//
// The defect: surfaces.json was watched BY PATH, so the watch bound to that
// file's inode. Anything that REPLACES rather than edits the file — npm ci,
// write-tmp+rename, a redeploy over an existing install, a save-by-rename
// editor — produced a new inode, and the old watch never fired again. The
// runtime sat on ENOENT indefinitely, serving an empty rail with HTTP 200,
// until someone restarted the process.
//
// Why the assertions look the way they do: warn-first output (empty rail, named
// error, 200) is honest AND is exactly what the stale-watcher bug looked like.
// So "no error" proves nothing here. Every recovery assertion checks a POSITIVE
// signal — the recoveries counter, lastRecoveryAt, and the log line — and every
// one is paired with a negative control that must NOT report a recovery. A
// counter that only ever increments would pass a one-sided test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join("app", "serve-studio.mjs");

const ONE = [{ id: "floor", name: "FLOOR", glyph: "●", path: "/surfaces/floor.html", hint: "one" }];
const TWO = [...ONE, { id: "two", name: "TWO", glyph: "◆", path: "/surfaces/two.html", hint: "two" }];

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A throwaway copy of the runtime — never the repo's own app/, never a live
// instance. serve-studio derives its paths from its own location, so a copy is
// fully isolated.
function instance(surfaces = ONE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redeploy-test-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const manifestPath = path.join(dir, "app", "surfaces.json");
  const doc = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  doc.surfaces = surfaces;
  fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2));
  return { dir, manifestPath, doc };
}

function writeManifest(manifestPath, surfaces) {
  const doc = JSON.parse(fs.readFileSync(manifestPath, "utf8").trim() || "{}");
  doc.surfaces = surfaces;
  fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2));
}

async function start(dir) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, SERVER), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });

  const contract = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/contract`, { cache: "no-store" });
    return (await r.json()).manifest;
  };

  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await contract(); break; } catch {
      if (Date.now() > deadline) { proc.kill(); throw new Error(`server never came up:\n${log}`); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Bounded wait on CONTENT, not a fixed sleep — a sleep long enough to be
  // reliable is long enough to hide a slow regression.
  const until = async (predicate, ms = 8000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await contract();
      if (predicate(last)) return last;
      if (Date.now() > end) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return {
    port, contract, until,
    log: () => log,
    text: async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { cache: "no-store" })).text(),
    status: async (p) => (await fetch(`http://127.0.0.1:${port}${p}`, { cache: "no-store" })).status,
    stop: () => proc.kill(),
  };
}

// ----------------------------------------------------- the A-G sequence

test("A-G: manifest survives delete -> recreate with no process restart", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  // A — baseline. NEGATIVE CONTROL: booting healthy is not "recovering".
  let m = await srv.contract();
  assert.equal(m.ok, true);
  assert.equal(m.surfaces, 1);
  assert.equal(m.state, "ok");
  assert.equal(m.recoveries, 0, "a process that started healthy must report 0 recoveries");
  assert.equal(m.lastRecoveryAt, null);

  // B — modify in place. Still not a recovery: it never broke.
  writeManifest(manifestPath, TWO);
  m = await srv.until((x) => x.surfaces === 2);
  assert.equal(m.surfaces, 2, "in-place edit was not picked up");
  assert.equal(m.recoveries, 0, "an ordinary edit must not be reported as a recovery");

  // C — delete. Warn-first: named error, empty rail, still serving.
  const saved = fs.readFileSync(manifestPath, "utf8");
  fs.unlinkSync(manifestPath);
  m = await srv.until((x) => x.state === "unreadable");
  assert.equal(m.state, "unreadable");
  assert.equal(m.surfaces, 0);
  assert.match(m.errors[0], /cannot read surfaces\.json/);
  assert.equal(await srv.status("/"), 200, "runtime must keep serving through a missing manifest");

  // D — recreate at the same path. THIS is the defect: pre-fix it stayed
  // ENOENT forever because the watch was bound to the deleted inode.
  fs.writeFileSync(manifestPath, saved);
  m = await srv.until((x) => x.state === "ok");
  assert.equal(m.state, "ok", "did not recover after delete -> recreate");
  assert.equal(m.surfaces, 2);

  // The recovery must be ASSERTED, not inferred from the absence of an error.
  assert.equal(m.recoveries, 1, "recovery must be reported positively");
  assert.ok(m.lastRecoveryAt, "lastRecoveryAt must be set on recovery");
  assert.match(srv.log(), /manifest RECOVERED:/, "recovery must emit a log line");

  // E — settle. Recovery is stable, not a flap.
  await new Promise((r) => setTimeout(r, 1500));
  m = await srv.contract();
  assert.equal(m.state, "ok");
  assert.equal(m.surfaces, 2);
  assert.equal(m.recoveries, 1, "a stable manifest must not keep incrementing recoveries");

  // F — edit the RECREATED file. Proves the watch is genuinely live again
  // rather than having fired once.
  writeManifest(manifestPath, [...TWO.slice(0, 1), { ...TWO[1], name: "TWO-EDITED" }]);
  // Wait on the SERVED CONTENT, not on a count that is already satisfied — the
  // surface count is 2 both before and after this edit, so polling it would
  // return instantly and assert against a stale read.
  const deadline = Date.now() + 8000;
  let served;
  do {
    served = JSON.parse(await srv.text("/surfaces.json"));
    if (served.surfaces[1]?.name === "TWO-EDITED") break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.equal(served.surfaces[1].name, "TWO-EDITED", "watch is not live after recreate");
});

test("G control: a fresh process reads the same file fine", async (t) => {
  // The control that makes the whole sequence trustworthy — it distinguishes
  // "the watcher was stale" from "the data on disk was broken". Kept after the
  // fix for exactly the same reason.
  const { dir, manifestPath } = instance(ONE);
  writeManifest(manifestPath, TWO);
  const srv = await start(dir);
  t.after(() => srv.stop());
  const m = await srv.contract();
  assert.equal(m.ok, true);
  assert.equal(m.surfaces, 2);
  assert.equal(m.recoveries, 0);
});

// ------------------------------------------------- replacement mechanisms

test("atomic write-tmp+rename is picked up", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  const doc = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  doc.surfaces = TWO;
  const tmp = manifestPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, manifestPath);   // atomic replace: new inode, same path

  const m = await srv.until((x) => x.surfaces === 2);
  assert.equal(m.surfaces, 2, "tmp+rename replace was not picked up");
  assert.equal(m.state, "ok");
});

test("recovers when the manifest's parent directory is itself replaced", async (t) => {
  // The npm-ci shape: the whole install tree goes away, so the manifest AND its
  // parent directory are gone and there is briefly nothing to watch. Recovery
  // here depends on the bounded probe, not on a filesystem event.
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  const appDir = path.dirname(manifestPath);
  const stash = path.join(dir, "app-stash");
  fs.renameSync(appDir, stash);
  const m1 = await srv.until((x) => x.state === "unreadable");
  assert.equal(m1.state, "unreadable");

  fs.renameSync(stash, appDir);       // tree comes back, new directory inode
  const m2 = await srv.until((x) => x.state === "ok", 10_000);
  assert.equal(m2.state, "ok", "did not recover after the parent directory was replaced");
  assert.equal(m2.recoveries, 1);
  assert.match(srv.log(), /manifest RECOVERED:/);
});

test("a directory SWAP is picked up, not served stale", async (t) => {
  // The nastiest shape, and the one no arrangement of watches can catch:
  // `mv current current.old && mv new current`. The watch keeps following the
  // OLD directory inode, which still exists under its new name, so no event
  // ever fires and no error is raised — the runtime would serve the PREVIOUS
  // manifest indefinitely while reporting state "ok". That is worse than the
  // ENOENT this slice started on, because it looks healthy.
  const { dir, manifestPath } = instance([{ id: "old", name: "OLD", glyph: "●", path: "/surfaces/floor.html" }]);
  const appDir = path.dirname(manifestPath);

  // a complete replacement tree, as a deploy would stage
  const incoming = path.join(dir, "app-incoming");
  fs.cpSync(appDir, incoming, { recursive: true });
  writeManifest(path.join(incoming, "surfaces.json"),
    [{ id: "new", name: "NEW", glyph: "▲", path: "/surfaces/floor.html" },
     { id: "new2", name: "NEW2", glyph: "◆", path: "/surfaces/floor.html" }]);

  const srv = await start(dir);
  t.after(() => srv.stop());
  assert.deepEqual(JSON.parse(await srv.text("/surfaces.json")).surfaces.map((r) => r.id), ["old"]);

  fs.renameSync(appDir, path.join(dir, "app-old"));
  fs.renameSync(incoming, appDir);

  const deadline = Date.now() + 8000;
  let ids;
  do {
    ids = JSON.parse(await srv.text("/surfaces.json")).surfaces.map((r) => r.id);
    if (ids.join() === "new,new2") break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);

  assert.deepEqual(ids, ["new", "new2"], "served stale content after a directory swap");
  const m = await srv.contract();
  assert.equal(m.state, "ok");

  // Being corrected is not the same as being observable. A clean swap goes
  // ok -> ok, so no RECOVERY is reported — and if that were the only signal,
  // nothing would distinguish "the watch saw it" from "the watch missed it and
  // the stat floor caught it". The stale-but-healthy-looking lie has to be
  // observably DETECTED, not merely fixed.
  assert.equal(m.recoveries, 0, "a clean swap never broke, so it is not a recovery");
  assert.ok(m.integrityReloads >= 1,
    "a directory swap must be reported as an integrity reload — the watch cannot see it");
  assert.ok(m.lastIntegrityReloadAt, "lastIntegrityReloadAt must be set when the guard fires");
  assert.match(srv.log(), /manifest REPLACED:/,
    "the integrity guard must emit a positive log line, not correct silently");
});

test("an idle runtime does not churn", async (t) => {
  // NEGATIVE CONTROL for the integrity guard: it stats every second, and it
  // must NOT reload a file that has not changed. Without this, "it reloads
  // eventually" could be passing for the wrong reason.
  const { dir } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  const before = (await srv.contract()).reloads;
  await new Promise((r) => setTimeout(r, 3500));
  const after = await srv.contract();

  assert.equal(after.reloads, before, "the integrity guard reloaded an unchanged manifest");
  assert.equal(after.recoveries, 0);
  assert.equal(after.state, "ok");
});

// ------------------------------------------------------ startup robustness
// The gap: every test above starts from a HEALTHY manifest, so an
// entire class of failure — the runtime dying during boot — was invisible to
// the suite. A redeploy is exactly when the manifest is most likely to be
// missing as the process starts, so booting into that state has to work.

test("starts and warn-firsts when the manifest is ABSENT at boot", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  fs.unlinkSync(manifestPath);

  const srv = await start(dir);   // start() throws if the process never serves
  t.after(() => srv.stop());

  const m = await srv.contract();
  assert.equal(m.state, "unreadable");
  assert.match(m.errors[0], /cannot read surfaces\.json/);
  assert.equal(await srv.status("/"), 200, "the shell must be available with no manifest");

  // and it must still recover once the file appears — a cold start into the
  // broken state must not disable the recovery path
  writeManifest2(manifestPath, TWO);
  const after = await srv.until((x) => x.state === "ok");
  assert.equal(after.state, "ok");
  assert.equal(after.surfaces, 2);
  assert.equal(after.recoveries, 1, "recovering from a boot-time failure is still a recovery");
});

test("starts and warn-firsts when the manifest is INVALID at boot", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  fs.writeFileSync(manifestPath, "{ not json at all");

  const srv = await start(dir);
  t.after(() => srv.stop());

  const m = await srv.contract();
  assert.equal(m.state, "invalid");
  assert.match(m.errors[0], /not valid JSON/);
  assert.equal(await srv.status("/"), 200);
  assert.equal(m.recoveries, 0, "booting broken is not a recovery");
});

test("starts when the manifest's whole directory is missing at boot", async (t) => {
  // The most hostile boot: mid-redeploy, the tree is not there yet.
  const { dir, manifestPath } = instance(ONE);
  fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.cpSync(path.join(REPO, "app", "serve-studio.mjs"), path.join(dir, SERVER));
  // THE RUNTIME IS NO LONGER ONE FILE. It imports ./verbs.mjs — the single
  // declaration of which verbs it owns, shared with the compositor so the two
  // cannot drift. A harness that copies the server alone gets ERR_MODULE_NOT_FOUND,
  // which is how this was found rather than by reading.
  fs.cpSync(path.join(REPO, "app", "verbs.mjs"), path.join(dir, "app", "verbs.mjs"));

  const srv = await start(dir);
  t.after(() => srv.stop());
  const m = await srv.contract();
  assert.equal(m.state, "unreadable");
  assert.equal(await srv.status("/api/contract"), 200);
});

// helper used by the boot tests: the manifest may not exist yet, so this one
// does not try to read the previous document first
function writeManifest2(manifestPath, surfaces) {
  fs.writeFileSync(manifestPath, JSON.stringify({ surfaces }, null, 2));
}

// ------------------------------------------------ warn-first non-regression

test("a genuinely invalid manifest still warn-firsts and is NOT reported as recovered", async (t) => {
  // The discriminator that matters most: a fix which made everything look
  // recovered would be worse than the bug it replaced.
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  fs.writeFileSync(manifestPath, JSON.stringify({ surfaces: [{ name: "NO ID" }] }, null, 2));
  const m = await srv.until((x) => x.state === "invalid");

  assert.equal(m.state, "invalid");
  assert.equal(m.ok, false);
  assert.equal(m.surfaces, 0, "an invalid row must be excluded from the served rail");
  assert.match(m.errors[0], /id is required/, "the error must be NAMED, not generic");
  assert.equal(m.recoveries, 0, "an invalid manifest must never be reported as a recovery");
  assert.equal(await srv.status("/"), 200, "the shell must stay available");
});

test("malformed JSON is named and the runtime keeps serving", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  fs.writeFileSync(manifestPath, "{ not json");
  const m = await srv.until((x) => x.state === "invalid");
  assert.match(m.errors[0], /not valid JSON/);
  assert.equal(await srv.status("/"), 200);
});

test("unknown fields still warn rather than error (forward-compat preserved)", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  writeManifest(manifestPath, [{ ...ONE[0], somethingNew: "from a later version" }]);
  const m = await srv.until((x) => x.warnings.length > 0);
  assert.equal(m.ok, true, "an unknown field must not be an error");
  assert.equal(m.surfaces, 1, "the row must still be served");
  assert.match(m.warnings[0], /unknown field/);
});

// ------------------------------------------------------- contract v0.1

test("contract v0.1 is unchanged: same version, same existing fields, additive only", async (t) => {
  const { dir } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  const r = await fetch(`http://127.0.0.1:${srv.port}/api/contract`, { cache: "no-store" });
  const body = await r.json();

  assert.equal(body.contractVersion, "0.1", "adding fields must not move the contract version");
  // CAPABILITIES MAY GAIN, NEVER LOSE. This asserted exact equality, which was
  // true when written and wrong as a rule: `capabilities` is the feature-detection
  // list, so it MUST grow when a namespace ships or it can never advertise
  // anything. Equality here would have blocked declaring focus and drive — the
  // very omission an independent cold build reported.
  //
  // Removing one IS breaking, because a consumer gates on it, so that is what is
  // still checked.
  for (const cap of ["contract.meta", "observe.factory-state", "stream.events", "files.read",
    "shell.protocol"]) {
    assert.ok(body.capabilities.includes(cap),
      `capability ${cap} disappeared — removing one breaks every consumer gating on it`);
  }
  for (const key of ["ok", "errors", "warnings", "surfaces"]) {
    assert.ok(key in body.manifest, `pre-existing manifest field ${key} disappeared`);
  }
  for (const key of ["state", "lastLoadedAt", "reloads", "recoveries", "lastRecoveryAt"]) {
    assert.ok(key in body.manifest, `additive observability field ${key} missing`);
  }
});

test("the SSE change-signal still fires on a manifest change", async (t) => {
  const { dir, manifestPath } = instance(ONE);
  const srv = await start(dir);
  t.after(() => srv.stop());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();

  const got = (async () => {
    // The deadline has to be ENFORCED, not merely stated. Awaiting read()
    // bare never returns if the event never arrives, so the loop could not
    // re-check its own deadline — the test would hang until the runner killed
    // it instead of failing with the reason it asserts. A stated timeout that
    // cannot fire is a check whose failure does not look like its failure.
    // 
    const deadline = Date.now() + 8000;
    let seen = "";
    while (Date.now() < deadline) {
      // The losing timer must be CLEARED. An uncleared referenced timer keeps
      // the event loop alive for its full duration after the race resolves —
      // the suite still passes, it just silently gets slower, which is a cost
      // nobody attributes to the test that caused it. 
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r("__timeout__"), Math.max(0, deadline - Date.now())); });
      const next = await Promise.race([reader.read(), timeout]);
      clearTimeout(timer);
      if (next === "__timeout__") return false;
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
      if (seen.includes("data:")) return true;
    }
    return false;
  })();

  await new Promise((r) => setTimeout(r, 300));
  writeManifest(manifestPath, TWO);
  assert.equal(await got, true, "no SSE change-signal after a manifest change");
});

// MOVED — doc/response parity now lives in ONE place: contract-response-parity.
//
// The assertion that stood here compared `documented.manifest` against the live
// MANIFEST only, while its comment promised "add a field without documenting it
// and this test fails". That was false for every level it did not check, and a
// top-level field sailed past it — a guard whose message oversells its assertion
// reads as coverage, which is worse than no guard.
//
// Two sibling guards had the same shape at other levels. Rather than add a
// fourth, the comparison became structural and descends everywhere. Its controls
// plant a field at all four levels and assert the path each is reported at.

test("startup runs after EVERY module binding, so the TDZ class cannot return", () => {
  // This asserts the STRUCTURE the source comment claims, rather than trusting
  // the comment. The earlier arrangement put init partway down the module and
  // was "safe" only because the current call graph happened not to reach the
  // later bindings — a property that silently expires the moment loadManifest
  // or watchForChanges grows a new dependency. Hoisting whichever binding
  // trips only moves the tripwire, so the position is asserted rather than
  // maintained by care.
  const src = fs.readFileSync(path.join(REPO, "app", "serve-studio.mjs"), "utf8").split("\n");

  const declarations = src
    .map((line, i) => (/^(let|const)\s/.test(line) ? i + 1 : null))
    .filter(Boolean);
  const startup = src
    .map((line, i) => (/^(watchForChanges|loadManifest)\(\);\s*$/.test(line) ? i + 1 : null))
    .filter(Boolean);

  assert.ok(startup.length >= 2, "expected the startup calls at module level");
  assert.ok(
    Math.min(...startup) > Math.max(...declarations),
    `startup runs at line ${Math.min(...startup)} but a module binding is declared at line ` +
    `${Math.max(...declarations)} — startup must follow EVERY declaration, not merely the ones ` +
    `it currently happens to touch`
  );
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
