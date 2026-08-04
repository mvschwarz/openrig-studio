// Controls for the provisioner's reuse decision.
//
//   node --test 'test/*.test.mjs'
//
// The reuse/refusal cases, plus the three boundaries a review found in the first
// version of this. Two of those three were cases the original controls could not
// have caught, and the reason is recorded on each:
//
//   * every server in the first pass answered 200 at /api/contract, so a foreign
//     listener answering 404 — classified "nothing", launched into, verified
//     against — was outside the shape of the whole harness;
//   * every path in the first pass was already canonical, so the exact-string
//     compare looked correct against four servers while trailing slashes,
//     relative paths and symlinks all deterministically refused.
//
// The last test is the one that keeps the rest honest: refusing every hostile
// input is also what an always-refuse guard does.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { reuseDecision, probePort, canonical, REUSE, NOT_MINE, NOTHING } from "../provision/studio-identity.mjs";

const MINE = "/home/op/studio/.runtime/surfaces";

// A well-formed studio contract response. Built as a whole valid document so a
// test that removes ONE field is testing that field rather than a fixture that
// was never valid.
const studio = (dir) => JSON.stringify({
  contractVersion: "0.1",
  runtime: { name: "openrig-studio", flavor: "reference-fixture" },
  capabilities: ["contract.meta", "observe.factory-state", "stream.events", "files.read", "shell.protocol"],
  manifest: {
    ok: true, errors: [], warnings: [], surfaces: 1,
    consumer: dir === null ? null : { dir, surfaces: 1, state: "ok" },
  },
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A server that answers however the test says, so the PROBE can be exercised
// rather than only the decision it wraps.
async function serve(handler) {
  const port = await freePort();
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  return { port, stop: () => new Promise((r) => srv.close(r)) };
}

// ------------------------------------------------------------ the decision

test("a studio serving THIS run's directory is reused", () => {
  // THE POSITIVE CONTROL, and it is the load-bearing one. Every other case here
  // refuses; a guard that refused unconditionally would pass all of them and
  // ship a provisioner that can never reuse anything.
  const d = reuseDecision({ body: studio(MINE), expectedDir: MINE });
  assert.equal(d.outcome, REUSE, d.reason);
});

test("a studio serving a DIFFERENT directory is refused, and both paths are named", () => {
  const theirs = "/home/op/other-studio/.runtime/surfaces";
  const d = reuseDecision({ body: studio(theirs), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.ok(d.reason.includes(theirs) && d.reason.includes(MINE),
    `the refusal must name what it found AND what it wanted: ${d.reason}`);
});

test("a ZERO-CONFIG studio is refused — it is a studio, but it cannot be this one", () => {
  const d = reuseDecision({ body: studio(null), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /no overlay configured/);
});

test("a server answering with something that is not JSON at all is refused", () => {
  const d = reuseDecision({ body: "<html>hello</html>", expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /did not return JSON/);
});

// ------------------------------------------------------- impostor shapes

test("minimal JSON carrying the expected dir is NOT accepted as a studio", () => {
  // The first impostor, reproduced verbatim. The earlier validator asked
  // only for a string contractVersion and a truthy manifest, so three keys and
  // the right path were enough to be adopted.
  const d = reuseDecision({
    body: JSON.stringify({ contractVersion: "0.1", manifest: { consumer: { dir: MINE } } }),
    expectedDir: MINE,
  });
  assert.equal(d.outcome, NOT_MINE, `a three-key object was accepted as a studio: ${d.reason}`);
});

test("a bogus contract version carrying the expected dir is refused", () => {
  const d = reuseDecision({
    body: JSON.stringify({ contractVersion: "definitely-not-openrig", manifest: { consumer: { dir: MINE } } }),
    expectedDir: MINE,
  });
  assert.equal(d.outcome, NOT_MINE);
});

test("a contract-shaped response from a DIFFERENT runtime is refused", () => {
  // The discriminating middle: everything valid except who is answering. This
  // caller installed this SDK's runtime, so it may require that runtime by name
  // rather than accept anything that implements the contract.
  const doc = JSON.parse(studio(MINE));
  doc.runtime.name = "some-other-runtime";
  const d = reuseDecision({ body: JSON.stringify(doc), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /not an openrig studio runtime/);
});

test("a studio that does not advertise contract.meta is refused", () => {
  const doc = JSON.parse(studio(MINE));
  doc.capabilities = ["observe.factory-state"];
  const d = reuseDecision({ body: JSON.stringify(doc), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /contract\.meta/);
});

// ------------------------------------------------------ path equivalence

test("ordinary spellings of the SAME directory all reuse", (t) => {
  // The alias table. `STUDIO_DIR=./studio` and a trailing slash are supported
  // input, not exotic — and each of them turned an idempotent rerun into exit 5
  // after a successful install. realpath proves the aliases really are the same
  // target, so a failure here is the comparison, not the fixture.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "alias-"));
  const real = fs.realpathSync(base);
  const overlay = path.join(real, "studio", ".runtime", "surfaces");
  fs.mkdirSync(overlay, { recursive: true });
  const link = path.join(real, "linked");
  fs.symlinkSync(path.join(real, "studio"), link);
  const before = process.cwd();
  process.chdir(real);
  t.after(() => process.chdir(before));

  const spellings = {
    "exact absolute": overlay,
    "trailing slash": overlay + "/",
    relative: path.join(".", "studio", ".runtime", "surfaces"),
    "symlink alias": path.join(link, ".runtime", "surfaces"),
  };
  for (const [label, spelling] of Object.entries(spellings)) {
    assert.equal(fs.realpathSync(spelling), fs.realpathSync(overlay),
      `fixture broken: ${label} does not reach the same target`);
    const d = reuseDecision({ body: studio(overlay), expectedDir: spelling });
    assert.equal(d.outcome, REUSE, `${label} was refused as foreign: ${d.reason}`);
  }
});

test("a genuinely different directory is still refused after normalisation", () => {
  // The negative half of the case above. Canonicalising must not become
  // "everything matches".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "alias-neg-"));
  const mine = path.join(base, "a"), theirs = path.join(base, "b");
  fs.mkdirSync(mine); fs.mkdirSync(theirs);
  const d = reuseDecision({ body: studio(theirs), expectedDir: mine + "/" });
  assert.equal(d.outcome, NOT_MINE, "normalisation collapsed two different directories");
});

test("canonical() leaves a non-existent path comparable instead of throwing", () => {
  const p = path.join(os.tmpdir(), "definitely-absent-" + process.pid, "x");
  assert.equal(canonical(p), path.resolve(p));
});

// -------------------------------- only a missing listener is "nothing"

test("a listener answering 404 at /api/contract is FOREIGN, never nothing", async (t) => {
  // The live control, and the failure it caught: `curl -f` reports a
  // refused connection and an HTTP 404 identically, so the shell classified an
  // occupied port as empty, launched into it, and the verifier then passed
  // against the foreign server. Every server in my own first pass answered 200,
  // so this case was outside the shape of that harness entirely.
  const s = await serve((req, res) => {
    if (req.url.startsWith("/api/contract")) { res.writeHead(404); return res.end("nope"); }
    res.writeHead(200, { "content-type": "text/html" }); res.end("<html>a surface</html>");
  });
  t.after(() => s.stop());

  const d = await probePort({ port: s.port, expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE, `an occupied port read as empty: ${d.reason}`);
  assert.match(d.reason, /HTTP 404/);
});

test("a listener that accepts TCP and then drops the request is FOREIGN, not nothing", async (t) => {
  // The other way into "occupied but unreadable": test 12 covers the response
  // that arrives and is wrong; this covers the response that never arrives, so
  // the probe's catch branch is exercised rather than only its !res.ok branch.
  //
  // The obvious version of this test accepts and HANGS — and it left a pending
  // promise that cancelled every test after it while still reporting `# fail 0`,
  // which is a worse failure than the one it was testing for. Resetting the
  // connection reaches the same branch without holding the event loop open.
  const srv = net.createServer((sock) => sock.destroy());
  const port = await freePort();
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  t.after(() => new Promise((r) => srv.close(r)));

  const d = await probePort({ port, expectedDir: MINE, timeoutMs: 2000 });
  assert.equal(d.outcome, NOT_MINE, `an occupied-but-unreadable port read as empty: ${d.reason}`);
  assert.match(d.reason, /refusing to treat an occupied port as empty/);
});

test("a genuinely empty port is nothing — so the probe is not simply refusing everything", async () => {
  // The positive control for the classification itself. Without it, "everything
  // is foreign" passes both tests above and the provisioner never launches.
  const d = await probePort({ port: await freePort(), expectedDir: MINE });
  assert.equal(d.outcome, NOTHING, d.reason);
});

test("a real matching studio contract over HTTP reuses, end to end", async (t) => {
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(studio(MINE));
  });
  t.after(() => s.stop());
  const d = await probePort({ port: s.port, expectedDir: MINE });
  assert.equal(d.outcome, REUSE, d.reason);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
