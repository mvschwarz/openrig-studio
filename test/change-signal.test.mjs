// Controls for the change signal: the marker, the process identity, and the
// helper the runtime serves.
//
//   node --test 'test/*.test.mjs'
//
// The design decisions these pin, each of which had an alternative:
//   * the marker is NORMATIVE and the transport is not, so a surface that only
//     polls is fully conformant and nothing is required to implement SSE;
//   * a CODE change is keyed on the runtime's process identity, not on a file
//     mtime, because a studio copies surfaces at boot and edited source does not
//     reach a browser until a restart;
//   * that identity is latched on FIRST OBSERVATION rather than on the first
//     SUCCESSFUL poll — latching on success is why a restart straddling startup
//     goes undetected in the implementation this replaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeRail, writeOverlayManifest } from "../tools/compose-rail.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start({ dir: existing, args = [] } = {}) {
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), "signal-"));
  if (!existing) {
    fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
    fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  }
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port), ...args],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { cache: "no-store" });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await (await get("/api/contract")).json(); break; }
    catch { if (Date.now() > deadline) { proc.kill(); throw new Error("never came up"); }
            await new Promise((r) => setTimeout(r, 100)); }
  }
  return { dir, port, get, text: async (p) => (await get(p)).text(), stop: () => proc.kill() };
}

// A studio laid out the way tools/studio.mjs lays one out: the developer's source
// beside a .runtime/ the composer copies INTO at boot. That copy is the whole
// reason the code trigger is a restart rather than a file event, so a control for
// it has to be built on the real composition rather than on a bare runtime.
function studio(pageBody, rowExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-studio-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const root = path.join(dir, "studio");
  fs.mkdirSync(path.join(root, "apps"), { recursive: true });
  fs.writeFileSync(path.join(root, "surfaces.json"), JSON.stringify({
    surfaces: [{ id: "mine", name: "MINE", glyph: "▲", path: "/surfaces/mine.html", ...rowExtra }],
  }, null, 2));
  fs.writeFileSync(path.join(root, "mine.html"), pageBody);
  return { dir, root };
}

function compose(root) {
  const rail = composeRail({
    appsRoot: path.join(root, "apps"),
    enabled: [],
    runtimeDir: path.join(root, ".runtime"),
    studioRoot: root,
  });
  writeOverlayManifest({ surfacesOut: rail.surfacesOut, rows: rail.rows });
  return rail.surfacesOut;
}

test("the runtime reports a process identity at /api/contract", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const c = await (await s.get("/api/contract")).json();
  assert.equal(typeof c.runtime.boot, "string");
  assert.ok(c.runtime.boot.length >= 8, `boot id too short to be distinguishing: ${c.runtime.boot}`);
});

test("the identity is STABLE across reads — it marks the process, not the request", async (t) => {
  // The discriminating half. A value that changed per request would satisfy
  // "there is a boot id" and make every poll look like a restart.
  const s = await start();
  t.after(() => s.stop());
  const a = (await (await s.get("/api/contract")).json()).runtime.boot;
  await new Promise((r) => setTimeout(r, 60));
  const b = (await (await s.get("/api/contract")).json()).runtime.boot;
  // Assert it EXISTS before asserting it is unchanged. The first version of this
  // compared two undefineds and passed against a runtime with no boot id at all
  // — a control that agrees when the feature is absent is not a control.
  assert.equal(typeof a, "string", "no boot id to be stable");
  assert.equal(a, b, "the boot id changed without a restart");
});

test("a RESTART changes it — so a code change is detectable at all", async (t) => {
  const a = await start();
  const first = (await (await a.get("/api/contract")).json()).runtime.boot;
  a.stop();
  const b = await start();
  t.after(() => b.stop());
  const second = (await (await b.get("/api/contract")).json()).runtime.boot;
  assert.notEqual(first, second, "two separate processes reported the same identity");
});

test("an edit that has NOT reached the browser does not move the identity — and the same edit DOES after a restart", async (t) => {
  // The other half of the code-change claim, and the half that says WHY the
  // trigger is a restart rather than a file event. A studio composes surfaces
  // into .runtime/ at boot, so editing the source changes a file the browser is
  // not being served. Watching that file would announce a change the page cannot
  // yet see, and a reload fired on it re-renders the SAME bytes — which teaches a
  // user that reloads do nothing, the opposite of what this contract is for.
  const { dir, root } = studio("<html>VERSION-ONE</html>");
  const overlay = compose(root);

  const a = await start({ dir, args: ["--surfaces", overlay] });
  t.after(() => a.stop());

  // Fixture control: the composed page really is the one being served, so the
  // "unchanged" readings below are about the runtime and not about a broken setup.
  assert.match(await a.text("/surfaces/mine.html"), /VERSION-ONE/,
    "fixture broken: the composed surface is not being served");
  const before = (await (await a.get("/api/contract")).json()).runtime.boot;
  assert.equal(typeof before, "string", "no identity to compare");

  // The developer — or an agent — edits the SOURCE.
  fs.writeFileSync(path.join(root, "mine.html"), "<html>VERSION-TWO</html>");
  assert.match(fs.readFileSync(path.join(root, "mine.html"), "utf8"), /VERSION-TWO/,
    "fixture broken: the edit did not land, so nothing below is under test");
  await new Promise((r) => setTimeout(r, 1500));   // past the watch AND the 1s integrity floor

  assert.match(await a.text("/surfaces/mine.html"), /VERSION-ONE/,
    "the edit reached the browser with no restart — this control no longer tests what it claims");
  const after = (await (await a.get("/api/contract")).json()).runtime.boot;
  assert.equal(after, before,
    "a source edit moved the process identity — the trigger is watching the file, not the restart");

  a.stop();

  // THE DISCRIMINATING HALF. Recompose and restart: the bytes AND the identity
  // both move. Without this, every assertion above is equally satisfied by a
  // runtime that never changes anything at all.
  compose(root);
  const b = await start({ dir, args: ["--surfaces", overlay] });
  t.after(() => b.stop());

  assert.match(await b.text("/surfaces/mine.html"), /VERSION-TWO/,
    "the restart did not pick up the edit, so the pairing proves nothing");
  const restarted = (await (await b.get("/api/contract")).json()).runtime.boot;
  assert.notEqual(restarted, before, "the restart did not change the identity");
});

test("the runtime serves the change-signal helper at a stable path", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const r = await s.get("/signal.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /javascript/);
  const body = await r.text();
  assert.match(body, /export function watchSignal/, "the helper does not export the documented entry point");
});

// MOVED — see test/contract-response-parity.test.mjs, which owns doc/response
// agreement at every level. This checked the `runtime` block only; two siblings
// checked `manifest` and `manifest.consumer`; nobody checked the top level, and
// a field added there was invisible to all three.

test("a declared preserve list is ACCEPTED and reaches the served row", async (t) => {
  // The declaration half of "the app says WHAT to keep, not HOW". Before this,
  // preserve was an unknown field: warned, and dropped from nothing but still
  // never contracted. An author following the schema would have been told their
  // documented field was unrecognised.
  const kinds = ["scroll", "playhead"];
  const { dir, root } = studio("<html>p</html>", { preserve: kinds });
  const overlay = compose(root);
  const s = await start({ dir, args: ["--surfaces", overlay] });
  t.after(() => s.stop());

  const m = (await (await s.get("/api/contract")).json()).manifest;
  assert.equal(m.ok, true, JSON.stringify(m.errors));
  assert.ok(!m.warnings.some((w) => /unknown field "preserve"/.test(w)),
    `preserve is contract now, so it must not be reported as unknown: ${JSON.stringify(m.warnings)}`);

  const row = (await (await s.get("/surfaces.json")).json()).surfaces.find((r) => r.id === "mine");
  assert.deepEqual(row.preserve, kinds,
    "the declared list did not survive into the served row, so nothing downstream could read it");
});

test("an unknown field STILL warns — so the clean read above is not a broken warning path", async (t) => {
  // The discriminator. Without it, "preserve produced no unknown-field warning"
  // passes just as happily against a runtime that stopped warning at all, which
  // is the forward-compat behaviour the contract promises.
  const { dir, root } = studio("<html>p</html>", { definitelyNotAField: "x" });
  const overlay = compose(root);
  const s = await start({ dir, args: ["--surfaces", overlay] });
  t.after(() => s.stop());

  const m = (await (await s.get("/api/contract")).json()).manifest;
  assert.ok(m.warnings.some((w) => /unknown field "definitelyNotAField"/.test(w)),
    `the unknown-field warning path is dead: ${JSON.stringify(m.warnings)}`);
  assert.equal(m.ok, true, "an unknown field must stay a warning, never an error");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
