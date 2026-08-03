// Regression suite for the consumer-surface-registration seam.
//
//   node --test 'test/*.test.mjs'
//
// The seam exists so a consumer of this SDK can register ITS OWN surfaces from
// outside the package. Before it, the only documented path pointed inside the
// package — which in a real install is node_modules/@openrig/studio/app/ —
// gitignored, wiped by npm ci, and carried by a copy: duplicating a
// node_modules tree duplicated phantom surface state, so a contaminated
// instance served 200 with a healthy manifest and the WRONG surfaces.
//
// So the tests below split into two claims that are NOT the same:
//
//   REGISTRATION works  — a consumer surface loads from outside the package.
//   THE CLASS IS GONE   — there is ZERO consumer state inside the package, so
//                         copying node_modules cannot inject a surface at all.
//
// The second is the one that matters and the one that is easy to pass by
// accident while failing in spirit: any cache, copy or materialisation of
// consumer surfaces into the package would satisfy the first and break the
// second. It is tested directly rather than inferred from the first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const CONSUMER_ROW = {
  id: "mine", name: "MINE", glyph: "▲", path: "/surfaces/mine.html", hint: "consumer-owned",
};
const CONSUMER_PAGE = "<!doctype html><html><head><title>MINE</title></head><body>consumer surface</body></html>";

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A throwaway copy of the runtime plus a SEPARATE consumer dir — the point of
// the seam is that these two are not the same tree.
function scaffold({ withConsumer = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-test-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const consumer = path.join(dir, "consumer");
  if (withConsumer) {
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({ surfaces: [CONSUMER_ROW] }, null, 2));
    fs.writeFileSync(path.join(consumer, "mine.html"), CONSUMER_PAGE);
  }
  return { dir, consumer, appDir: path.join(dir, "app") };
}

async function start(dir, args = []) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port), ...args],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });

  const get = async (p) => fetch(`http://127.0.0.1:${port}${p}`, { cache: "no-store" });
  const contract = async () => (await (await get("/api/contract")).json()).manifest;

  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await contract(); break; } catch {
      if (Date.now() > deadline) { proc.kill(); throw new Error(`server never came up:\n${log}`); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const until = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await contract();
      if (pred(last)) return last;
      if (Date.now() > end) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    port, get, contract, until, log: () => log,
    rows: async () => (await (await get("/surfaces.json")).json()).surfaces,
    text: async (p) => (await get(p)).text(),
    status: async (p) => (await get(p)).status,
    stop: () => proc.kill(),
  };
}

// Every file under a root, relative — used to assert the package is untouched.
function treeOf(root) {
  const out = [];
  const walk = (d, prefix) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full, path.join(prefix, name));
      else out.push(path.join(prefix, name));
    }
  };
  walk(root, "");
  return out;
}

// ------------------------------------------------------- registration works

test("a consumer surface registers from OUTSIDE the package and is served", async (t) => {
  const { dir, consumer } = scaffold();
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const m = await srv.contract();
  assert.equal(m.ok, true, JSON.stringify(m.errors));
  assert.equal(m.surfaces, 2, "expected FLOOR plus the consumer surface");
  assert.deepEqual((await srv.rows()).map((r) => r.id), ["floor", "mine"]);

  // The rail must derive from the ARTIFACT, not merely look right: the served
  // bytes have to be the consumer's file.
  assert.equal(await srv.text("/surfaces/mine.html"), CONSUMER_PAGE);
  assert.equal(fs.readFileSync(path.join(consumer, "mine.html"), "utf8"), CONSUMER_PAGE);

  assert.equal(m.consumer.dir, consumer);
  assert.equal(m.consumer.surfaces, 1);
  assert.equal(m.consumer.state, "ok");
});

test("the env var registers the same way as the flag", async (t) => {
  const { dir, consumer } = scaffold();
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENRIG_STUDIO_SURFACES: consumer } });
  t.after(() => proc.kill());

  const deadline = Date.now() + 10_000;
  let m;
  for (;;) {
    try { m = (await (await fetch(`http://127.0.0.1:${port}/api/contract`)).json()).manifest; break; }
    catch { if (Date.now() > deadline) throw new Error("server never came up"); await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.equal(m.surfaces, 2);
  assert.equal(m.consumer.dir, consumer);
});

// ------------------------------------------- THE CLASS IS GONE 

test("ZERO consumer state is written into the package — the package tree is byte-identical after serving", async (t) => {
  // This is the claim the slice exists for, and it is stronger than
  // "registration happens outside". A cache, copy or materialisation of
  // consumer surfaces into the package would pass every registration test
  // above and destroy the property.
  const { dir, consumer, appDir } = scaffold();

  const before = treeOf(appDir).map((f) => [f, fs.readFileSync(path.join(appDir, f), "utf8")]);

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());
  await srv.contract();
  await srv.text("/surfaces/mine.html");        // exercise the serving path
  await srv.rows();
  await new Promise((r) => setTimeout(r, 1500)); // let the integrity guard run

  const after = treeOf(appDir).map((f) => [f, fs.readFileSync(path.join(appDir, f), "utf8")]);
  assert.deepEqual(after.map(([f]) => f), before.map(([f]) => f),
    "a file appeared in or vanished from the package tree");
  assert.deepEqual(after, before, "package file CONTENT changed — consumer state leaked into the package");

  // And specifically: no trace of the consumer surface in the places consumer
  // state would actually materialise — the package manifest and the package's
  // surfaces dir. Scoped deliberately: a blob search across the whole tree also
  // matches this runtime's own source COMMENTS, which discuss consumer surfaces
  // at length and were there before the server ever started. That would be a
  // test failing on its own documentation rather than on a leak.
  const packageManifest = fs.readFileSync(path.join(appDir, "surfaces.json"), "utf8");
  assert.doesNotMatch(packageManifest, /"id":\s*"mine"/, "consumer ROW written into the package manifest");
  assert.equal(JSON.parse(packageManifest).surfaces.length, 1, "the package manifest gained a row");

  const surfacesDir = path.join(appDir, "surfaces");
  for (const name of fs.readdirSync(surfacesDir)) {
    const body = fs.readFileSync(path.join(surfacesDir, name), "utf8");
    assert.doesNotMatch(body, /consumer surface/, `consumer PAGE content materialised into the package as ${name}`);
  }
  assert.ok(!fs.existsSync(path.join(surfacesDir, "mine.html")),
    "the consumer page was copied into the package");
});

test("a PRE-CONTAMINATED package cannot inject — undeclared rows and pages are rejected and warned", async (t) => {
  // The guarantee : with the seam active the runtime
  // serves EXACTLY the SDK's own declared surfaces plus the consumer's
  // overlay-declared ones, and nothing else. Undeclared rows and files in the
  // package are ignored for serving AND warned, so contamination is visible
  // rather than silently masked.
  //
  // Two failure modes this case is written against, because both produce a
  // green suite:
  //   1. setting up only half the condition — a phantom PAGE without its row —
  //      leaves the assertion unable to fail, and a test that cannot fail is
  //      not a test;
  //   2. prose that describes a weaker policy than the assertions enforce makes
  //      the weaker one look ratified, which is worse than having no test at
  //      all.
  // So the setup creates both halves, and the prose and the assertions state
  // the same guarantee.
  const origin = scaffold();

  // contaminate the package the way materialisation used to: page AND row, in
  // the PACKAGE's own manifest
  fs.writeFileSync(path.join(origin.appDir, "surfaces", "phantom.html"), "<html>PHANTOM</html>");
  const pkgManifest = path.join(origin.appDir, "surfaces.json");
  const pkgDoc = JSON.parse(fs.readFileSync(pkgManifest, "utf8"));
  pkgDoc.surfaces.push({ id: "phantom", name: "PHANTOM", path: "/surfaces/phantom.html" });
  fs.writeFileSync(pkgManifest, JSON.stringify(pkgDoc, null, 2));

  // copy the contaminated package into a FRESH deployment with a DIFFERENT consumer
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "seam-copy-"));
  fs.cpSync(origin.appDir, path.join(dest, "app"), { recursive: true });
  fs.cpSync(path.join(origin.dir, "fixtures"), path.join(dest, "fixtures"), { recursive: true });
  const freshConsumer = path.join(dest, "consumer");
  fs.mkdirSync(freshConsumer);
  fs.writeFileSync(path.join(freshConsumer, "surfaces.json"),
    JSON.stringify({ surfaces: [{ id: "theirs", name: "THEIRS", path: "/surfaces/theirs.html" }] }, null, 2));
  fs.writeFileSync(path.join(freshConsumer, "theirs.html"), "<html>theirs</html>");

  const srv = await start(dest, ["--surfaces", freshConsumer]);
  t.after(() => srv.stop());
  const ids = (await srv.rows()).map((r) => r.id);

  // WHAT THE SEAM DELIVERS: the origin deployment's CONSUMER surface did not
  // ride along, because it was never in the package to be copied.
  assert.ok(!ids.includes("mine"),
    "a consumer surface from the origin deployment rode along inside the copied package");
  assert.ok(ids.includes("theirs"), "the fresh consumer's own surface must be served");

  // THE RAISED GUARANTEE : a pre-contaminated package
  // CANNOT inject. The earlier version of this test pinned the OPPOSITE as an
  // accepted limitation — that limitation is unacceptable, because a seam
  // that only prevents NEW contamination does not remove the class, which is
  // what this slice is for.
  assert.ok(!ids.includes("phantom"),
    "a phantom row injected into the PACKAGE manifest was served — the runtime must serve exactly " +
    "the SDK's own declared surfaces plus the consumer's overlay-declared ones, and nothing else");

  // and the contamination must be VISIBLE rather than silently dropped, so an
  // operator learns the package is dirty instead of just not seeing a surface
  const m = await srv.contract();
  assert.ok(m.warnings.some((w) => /phantom/.test(w)),
    "undeclared package content must be WARNED, not silently ignored — masking it would hide the " +
    "contamination instead of surfacing it");

  // the phantom PAGE must not be reachable either
  assert.equal(await srv.status("/surfaces/phantom.html"), 404,
    "the phantom page is still served even though its row was rejected");
});

// ------------------------------------------------------------- npm ci

test("npm ci does not wipe the consumer registration, and WOULD wipe an in-package one", async (t) => {
  // The discriminating pair. "Still there after npm ci" proves nothing unless
  // the old path is shown to be destroyed by the same command in the same run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-npmci-"));
  const packed = execSync(`npm pack ${JSON.stringify(REPO)} --pack-destination ${JSON.stringify(dir)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "seam-consumer", version: "1.0.0", private: true,
    dependencies: { "@openrig/studio": `file:${path.join(dir, packed)}` },
  }, null, 2));
  execSync("npm install --silent", { cwd: dir, stdio: "ignore" });

  const pkgApp = path.join(dir, "node_modules", "@openrig", "studio", "app");
  const consumer = path.join(dir, "surfaces");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({ surfaces: [CONSUMER_ROW] }, null, 2));
  fs.writeFileSync(path.join(consumer, "mine.html"), CONSUMER_PAGE);

  // the OLD path, for the negative control: a surface materialised INTO the package
  fs.writeFileSync(path.join(pkgApp, "surfaces", "legacy.html"), "<html>legacy</html>");
  assert.ok(fs.existsSync(path.join(pkgApp, "surfaces", "legacy.html")));

  execSync("npm ci --silent", { cwd: dir, stdio: "ignore" });

  // NEGATIVE CONTROL: the in-package surface is gone, so npm ci really did
  // recreate node_modules and the survival below means something.
  assert.ok(!fs.existsSync(path.join(pkgApp, "surfaces", "legacy.html")),
    "npm ci did not recreate node_modules — the survival assertion would be vacuous");

  // the consumer's registration is untouched
  assert.ok(fs.existsSync(path.join(consumer, "surfaces.json")));
  assert.ok(fs.existsSync(path.join(consumer, "mine.html")));

  const srv = await start(dir === dir ? path.join(dir, "node_modules", "@openrig", "studio") : dir,
    ["--surfaces", consumer, "--fixtures", path.join(dir, "node_modules", "@openrig", "studio", "fixtures")]);
  t.after(() => srv.stop());
  const ids = (await srv.rows()).map((r) => r.id);
  assert.ok(ids.includes("mine"), "the consumer surface did not survive npm ci");
});

// --------------------------------------------------- opt-in / non-breaking

test("FLOOR works with ZERO consumer config", async (t) => {
  // Proven by running that path, not by reasoning that it was not touched.
  const { dir } = scaffold({ withConsumer: false });
  const srv = await start(dir);
  t.after(() => srv.stop());

  const m = await srv.contract();
  assert.equal(m.ok, true);
  assert.equal(m.surfaces, 1, "FLOOR alone");
  assert.deepEqual((await srv.rows()).map((r) => r.id), ["floor"]);
  assert.equal(m.consumer, null, "the consumer block must be null when no overlay is configured");
  assert.equal(await srv.status("/surfaces/floor.html"), 200);
});

test("zero-config validation errors are UNLABELLED, exactly as before the seam", async (t) => {
  // contract-meta lists changing an error contract as BREAKING, and a
  // zero-config consumer never opted into anything. Labels are for people who
  // configured a second manifest.
  const { dir, appDir } = scaffold({ withConsumer: false });
  fs.writeFileSync(path.join(appDir, "surfaces.json"), JSON.stringify({ surfaces: [{ name: "NO ID" }] }));
  const srv = await start(dir);
  t.after(() => srv.stop());

  const m = await srv.until((x) => x.errors.length > 0);
  assert.equal(m.errors[0], "surfaces[0]: id is required (non-empty string)");
});

test("with an overlay, errors ARE source-labelled so a merged rail stays legible", async (t) => {
  const { dir, appDir, consumer } = scaffold();
  fs.writeFileSync(path.join(appDir, "surfaces.json"), JSON.stringify({ surfaces: [{ name: "NO ID" }] }));
  fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({ surfaces: [{ name: "ALSO NO ID" }] }));
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  // With enforcement active an undeclared PACKAGE row is dropped as
  // contamination BEFORE validation, so it surfaces as a labelled WARNING
  // rather than a validation error — a malformed row cannot deep-equal a
  // declared one, so it is undeclared by construction. The consumer's own
  // malformed row still errors, labelled. Both are labelled, which is what this
  // test is about: in a merged world a bare surfaces[i] identifies nothing.
  const m = await srv.until((x) => x.errors.length >= 1 && x.warnings.length >= 1);
  assert.ok(m.errors.some((e) => e.startsWith("consumer surfaces[0]")), JSON.stringify(m.errors));
  assert.ok(m.warnings.some((w) => w.startsWith("package surfaces[0]")), JSON.stringify(m.warnings));
});

// ------------------------------------------------------------ precedence

test("a consumer row SHADOWS a package row of the same id — and says so", async (t) => {
  const { dir, consumer } = scaffold();
  fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({
    surfaces: [{ id: "floor", name: "MY FLOOR", path: "/surfaces/myfloor.html" }],
  }, null, 2));
  fs.writeFileSync(path.join(consumer, "myfloor.html"), "<html>my floor</html>");

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const rows = await srv.rows();
  assert.equal(rows.length, 1, "the shadowed package row must not also appear");
  assert.equal(rows[0].name, "MY FLOOR", "the consumer row must win");

  const m = await srv.contract();
  assert.ok(m.warnings.some((w) => /SHADOWS the package surface/.test(w)),
    "shadowing must be named: a silent replacement gives an operator no way to learn something was displaced");
});

test("serving is REGISTRATION-aware: an unregistered consumer file never wins", async (t) => {
  // Regression: The overlay was resolved path-first, which made it a
  // public static root: any file under it answered /surfaces/<name> whether or
  // not a row registered it. Three consequences, all reproduced and all
  // asserted here.
  const { dir, consumer } = scaffold();
  fs.writeFileSync(path.join(consumer, "floor.html"), "CONSUMER-FLOOR-OVERRIDE");   // unregistered
  fs.writeFileSync(path.join(consumer, "secret.txt"), "SECRET");                    // unregistered
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  // 1. an UNREGISTERED consumer file must not outrank a registered package page
  const floor = await srv.text("/surfaces/floor.html");
  assert.doesNotMatch(floor, /CONSUMER-FLOOR-OVERRIDE/,
    "an unregistered consumer file silently overrode the registered package page");

  // 2. an unregistered file in the overlay must not be published at all
  assert.equal(await srv.status("/surfaces/secret.txt"), 404, "the overlay is acting as a public static root");
  assert.doesNotMatch(await srv.text("/surfaces/secret.txt"), /SECRET/);

  // the registered consumer surface still works
  assert.equal(await srv.text("/surfaces/mine.html"), CONSUMER_PAGE);
});

test("a registered consumer row with a MISSING page fails as itself, with no cross-owner fallback", async (t) => {
  // The third of QA's reproductions. Quietly serving the package's bytes under
  // the consumer's row would make row ownership and page ownership disagree —
  // a lie about what is being served, and precisely what the id-based, warned
  // shadow semantics exist to prevent.
  const { dir, consumer } = scaffold();
  fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({
    surfaces: [{ id: "floor", name: "MY FLOOR", path: "/surfaces/floor.html" }],   // page NOT created
  }, null, 2));

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  assert.equal(await srv.status("/surfaces/floor.html"), 404,
    "the package's FLOOR page was substituted under the consumer's row");
  const body = await srv.text("/surfaces/floor.html");
  assert.match(body, /registered for this path but its page is missing/);
  assert.doesNotMatch(body, /<!doctype html>/i, "package page bytes were served");
});

test("the overlay serving root is contained — traversal is refused", async (t) => {
  const { dir, consumer } = scaffold();
  fs.writeFileSync(path.join(path.dirname(consumer), "secret.txt"), "SECRET");

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  for (const attempt of ["/surfaces/../secret.txt", "/surfaces/..%2fsecret.txt", "/surfaces/../../etc/hosts"]) {
    const body = await srv.text(attempt);
    assert.doesNotMatch(body, /SECRET/, `traversal escaped the overlay root: ${attempt}`);
  }
});

// ------------------------------------------- redeploy survival, for the CONSUMER

test("the CONSUMER manifest survives delete -> recreate with no restart", async (t) => {
  // The redeploy-survival guarantees have to hold for the consumer manifest too.
  // Consumer surfaces are what a real deployment actually redeploys, so this is
  // where the class does the most damage if it returns.
  const { dir, consumer } = scaffold();
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const manifest = path.join(consumer, "surfaces.json");
  const saved = fs.readFileSync(manifest, "utf8");
  assert.equal((await srv.contract()).surfaces, 2);

  fs.unlinkSync(manifest);
  let m = await srv.until((x) => x.consumer.state === "unreadable");
  assert.equal(m.consumer.state, "unreadable");
  assert.equal(m.surfaces, 1, "the rail falls back to FLOOR alone");

  fs.writeFileSync(manifest, saved);
  m = await srv.until((x) => x.consumer.state === "ok");
  assert.equal(m.surfaces, 2, "the consumer manifest did not recover");
  assert.equal(m.consumer.recoveries, 1, "recovery must be reported positively for the consumer source");
  assert.match(srv.log(), /manifest RECOVERED:/);
});

test("a CONSUMER directory swap is detected and served fresh", async (t) => {
  const { dir, consumer } = scaffold();
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());
  assert.deepEqual((await srv.rows()).map((r) => r.id), ["floor", "mine"]);

  const incoming = path.join(dir, "consumer-next");
  fs.mkdirSync(incoming);
  fs.writeFileSync(path.join(incoming, "surfaces.json"), JSON.stringify({
    surfaces: [{ id: "swapped", name: "SWAPPED", path: "/surfaces/swapped.html" }],
  }, null, 2));
  fs.writeFileSync(path.join(incoming, "swapped.html"), "<html>swapped</html>");

  fs.renameSync(consumer, path.join(dir, "consumer-old"));
  fs.renameSync(incoming, consumer);

  const deadline = Date.now() + 8000;
  let ids;
  do {
    ids = (await srv.rows()).map((r) => r.id);
    if (ids.includes("swapped")) break;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);

  assert.deepEqual(ids, ["floor", "swapped"], "served stale consumer content after a directory swap");
  const m = await srv.contract();
  assert.ok(m.consumer.integrityReloads >= 1,
    "a consumer directory swap must be reported as an integrity reload, not corrected silently");
  assert.match(srv.log(), /manifest REPLACED:/);
});

test("an idle overlay does not churn", async (t) => {
  const { dir, consumer } = scaffold();
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const before = (await srv.contract()).consumer.reloads;
  await new Promise((r) => setTimeout(r, 3500));
  const after = (await srv.contract()).consumer;
  assert.equal(after.reloads, before, "the integrity guard reloaded an unchanged consumer manifest");
  assert.equal(after.integrityReloads, 0);
});

test("the seat report and the served roster cannot disagree about whose seats are live", async (t) => {
  // These were computed in two places. A report that describes something the
  // runtime is not doing is the failure this codebase keeps paying for, so the
  // resolution lives in one function and this asserts the two consumers of it
  // still agree — measured against a booted runtime, not read off the source.
  const { dir, consumer } = scaffold();
  fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({
    surfaces: [CONSUMER_ROW],
    chatSeats: [{ seat: "one@rig", name: "ONE" }, { seat: "two@rig", name: "TWO" }],
    chatLocalPort: 8797,
  }, null, 2));

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const report = (await srv.contract()).seats;
  const served = JSON.parse(await srv.text("/surfaces.json"));

  assert.equal(report.source, "consumer", "the consumer declared a roster; the report must say so");
  assert.equal(report.count, served.chatSeats.length, "report count and served roster disagree");
  assert.equal(report.attachable, served.chatLocalPort !== undefined);
  assert.deepEqual(served.chatSeats.map((s) => s.seat), ["one@rig", "two@rig"]);

  // REPLACE, not merge: the package fixture seat must not ride along, or every
  // real box's roster carries the SDK's invented seat.
  assert.ok(!served.chatSeats.some((s) => /fixture/.test(s.seat)),
    "the package fixture seat was merged into the consumer roster");
});

test("with an overlay that declares NO seats, the report says the roster is the package's", async (t) => {
  // The discriminating half. Without this, `source` could be hardcoded to
  // "consumer" whenever an overlay exists and the test above would still pass.
  const { dir, consumer } = scaffold();
  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const report = (await srv.contract()).seats;
  assert.equal(report.source, "package", "an overlay with no chatSeats must not claim the roster");
  assert.equal(report.attachable, false, "the package fixture declares no chatLocalPort");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});

// -------------------------------------------------- the authority root

test("the SDK's declared ROWS deep-equal what the package actually ships", () => {
  // DRIFT GUARD. the earlier id-only version was worthless: it
  // passed while FLOOR's name, glyph and path were all changed, because only
  // the id was compared. An authority that checks the id is bypassed by reusing
  // the id, so the guard has to check what the authority checks — the whole row.
  const src = fs.readFileSync(path.join(REPO, "app", "serve-studio.mjs"), "utf8");
  const block = src.match(/const SDK_DECLARED_SURFACES = \[([\s\S]*?)\n\];/)[1];
  const declared = JSON.parse("[" + block.replace(/(\w+):/g, '"$1":').replace(/,\s*$/, "") + "]");

  const shipped = JSON.parse(fs.readFileSync(path.join(REPO, "app", "surfaces.json"), "utf8")).surfaces;

  const canon = (rows) => rows
    .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
    .sort();

  assert.deepEqual(canon(declared), canon(shipped),
    "the SDK's in-code row declaration and its shipped manifest disagree. Declare SDK surfaces " +
    "EXACTLY as shipped — an id-level match is not enough, because the authority compares whole rows");
});

test("reusing a DECLARED id with different content does not make a row authoritative", async (t) => {
  //  With an id-only authority, an injected row reusing the
  // declared id served a page the SDK never shipped, under a trusted name.
  const { dir, consumer, appDir } = scaffold();
  const doc = JSON.parse(fs.readFileSync(path.join(appDir, "surfaces.json"), "utf8"));
  doc.surfaces.unshift({ id: "floor", name: "STALE FLOOR", glyph: "X", path: "/surfaces/stale.html" });
  fs.writeFileSync(path.join(appDir, "surfaces.json"), JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(appDir, "surfaces", "stale.html"), "STALE-PAGE");

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  // BOTH halves, because asserting only rejection is what let the next defect
  // through: a PREPENDED stray row got the genuine FLOOR
  // rejected as its duplicate before the authority filter ran, so the stray
  // bytes were refused AND the authoritative surface vanished. The guarantee is
  // that the served set IS the declared set — a declared surface must SURVIVE
  // contamination, not merely fail to be replaced by it.
  assert.equal(await srv.status("/surfaces/stale.html"), 404, "a stray row reusing a declared id was served");

  const rows = await srv.rows();
  assert.ok(!rows.some((r) => r.name === "STALE FLOOR"), "the stale row reached the rail");
  assert.ok(rows.some((r) => r.id === "floor" && r.name === "FLOOR"),
    "the GENUINE FLOOR row was suppressed by the stray one — contamination must not remove a declared surface");

  const floor = await srv.text("/surfaces/floor.html");
  assert.match(floor, /<!doctype html>/i, "the genuine FLOOR page must still be served");

  const m = await srv.contract();
  assert.ok(m.warnings.some((w) => /NOT declared by this SDK/.test(w)), "the injected row was not warned");
  assert.ok(!m.warnings.some((w) => /floor\.html: present but NOT declared/.test(w)),
    "the genuine FLOOR file was misclassified as undeclared");
});

test("a consumer row may not steal a package-owned PATH with a different id", async (t) => {
  //  Replacement is an ID act that warns; allowing a
  // different-id row to claim a package path made it a filename act that was
  // silent, and made both rail rows load consumer bytes.
  const { dir, consumer } = scaffold();
  fs.writeFileSync(path.join(consumer, "surfaces.json"), JSON.stringify({
    surfaces: [{ id: "other", name: "OTHER", path: "/surfaces/floor.html" }],
  }, null, 2));
  fs.writeFileSync(path.join(consumer, "floor.html"), "CONSUMER-BYTES");

  const srv = await start(dir, ["--surfaces", consumer]);
  t.after(() => srv.stop());

  const body = await srv.text("/surfaces/floor.html");
  assert.doesNotMatch(body, /CONSUMER-BYTES/, "a different-id consumer row took over the package path");
  assert.match(body, /<!doctype html>/i, "the package FLOOR page must still be served");

  const m = await srv.contract();
  assert.ok(m.errors.some((e) => /already owned by the package surface/.test(e)),
    "the colliding consumer row must be EXCLUDED with a named error");
  assert.ok(!m.warnings.some((w) => /floor\.html: present but NOT declared/.test(w)),
    "the genuine package FLOOR file must not be falsely reported as undeclared");
});

test("with NO overlay, undeclared package content is served exactly as before", async (t) => {
  // The enforcement is opt-in with the seam. Applying it unconditionally would
  // change zero-config serving semantics — a vendored SDK that legitimately
  // added a row to its own manifest would stop serving it — and contract-meta
  // calls changing URL-resolution semantics breaking.
  const { dir, appDir } = scaffold({ withConsumer: false });
  fs.writeFileSync(path.join(appDir, "surfaces", "extra.html"), "<html>extra</html>");
  const doc = JSON.parse(fs.readFileSync(path.join(appDir, "surfaces.json"), "utf8"));
  doc.surfaces.push({ id: "extra", name: "EXTRA", path: "/surfaces/extra.html" });
  fs.writeFileSync(path.join(appDir, "surfaces.json"), JSON.stringify(doc, null, 2));

  const srv = await start(dir);
  t.after(() => srv.stop());

  const m = await srv.contract();
  assert.equal(m.surfaces, 2, "zero-config must still serve whatever the package manifest declares");
  assert.deepEqual((await srv.rows()).map((r) => r.id), ["floor", "extra"]);
  assert.equal(await srv.status("/surfaces/extra.html"), 200);
  assert.equal(m.warnings.length, 0, "no contamination warnings without an overlay");
});
