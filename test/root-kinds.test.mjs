// Root KINDS are supposed to be an open vocabulary.
//
//   node --test 'test/*.test.mjs'
//
// The manifest format's promise is "roots declare KINDS; the install binds
// them" — the installer's own refusal says exactly that. But the set of kinds
// that could actually BIND was a closed hardcoded list (project/media/canvas/
// footage) in three places: the installer's `bound` map, its ROOT_KEYS hint,
// and the runtime's ROOTS resolver. So an app needing any other kind of
// directory could not be installed at all, and the failure told the operator to
// "add a binding" to a file that had no shape to accept one.
//
// That is the same defect class this project already removed once, when host
// capabilities were a special case (`requires.host_capabilities`) instead of an
// ordinary provider: a mechanism that works for the things enumerated when it
// was written, and rots for everything after. Found while building a fleet
// dashboard whose state is box-level — neither project, media, canvas nor
// footage — so there was no honest kind to declare.
//
// THE THREE CLAIMS BELOW ARE NOT THE SAME, and the third is the one that makes
// the fix safe rather than merely permissive:
//
//   OPEN     — a kind the SDK has never heard of binds from studio.json.
//   LEGACY   — the four original keys still bind, unchanged.
//   STILL REFUSES — a declared kind with NO binding is still a refusal.
//
// Without the third, "open the vocabulary" degrades into "accept anything",
// which would let an app install with a root that resolves nowhere and fail at
// the moment of use — the exact silent-install failure the installer exists to
// prevent. An over-permissive binder and a correct one are indistinguishable
// unless you assert the refusal still fires.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const INSTALL = path.join(REPO, "tools", "install-app.mjs");

// A minimal ultralight app that declares ONE root kind and nothing else, so the
// only thing under test is whether that kind binds.
function makeApp(dir, kind) {
  const app = path.join(dir, "probe-app");
  fs.mkdirSync(path.join(app, "app"), { recursive: true });
  fs.writeFileSync(path.join(app, "app", "probe.html"),
    "<!doctype html><html><head><title>PROBE</title></head><body>probe</body></html>");
  fs.writeFileSync(path.join(app, "app.json"), JSON.stringify({
    manifest_version: 1,
    id: "probe-app",
    name: "PROBE",
    summary: "Root-kind binding probe.",
    category: "studio",
    surface: { entry: "app/probe.html", path: "/surfaces/probe.html", glyph: "▣", hint: "probe" },
    roots: { [kind]: { required: true } },
  }, null, 2));
  return app;
}

function makeStudio(dir, studioJson) {
  const studio = path.join(dir, "studio");
  fs.mkdirSync(path.join(studio, "apps"), { recursive: true });
  fs.writeFileSync(path.join(studio, "studio.json"), JSON.stringify(studioJson, null, 2));
  return studio;
}

function install(studio, appDir) {
  return spawnSync(process.execPath, [INSTALL, appDir], {
    encoding: "utf8",
    env: { ...process.env, OPENRIG_STUDIO_DIR: studio },
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "root-kinds-"));

test("OPEN: a root kind the SDK has never heard of binds from studio.json roots{}", () => {
  const dir = tmp();
  const bound = path.join(dir, "fleet-state");
  fs.mkdirSync(bound, { recursive: true });

  const studio = makeStudio(dir, {
    apps: [],
    appsRoot: path.join(dir, "studio", "apps"),
    roots: { fleet: bound },
  });
  const r = install(studio, makeApp(dir, "fleet"));

  // Assert on CONTENT, not exit status alone: a refusal for an unrelated reason
  // would also produce a non-zero exit and would read as this bug.
  assert.match(r.stdout, /root "fleet" binds to/,
    `expected "fleet" to bind from studio.json roots{}.\n--- stdout ---\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /root "fleet" has no binding/,
    "the kind was declared and bound in studio.json, so it must not be refused");
  assert.equal(r.status, 0, `install should succeed.\n--- stdout ---\n${r.stdout}`);
});

test("LEGACY: the four original keys still bind by their own studio.json names", () => {
  const dir = tmp();
  const proj = path.join(dir, "proj");
  fs.mkdirSync(proj, { recursive: true });

  const studio = makeStudio(dir, {
    apps: [],
    appsRoot: path.join(dir, "studio", "apps"),
    sliceRoot: proj,
  });
  const r = install(studio, makeApp(dir, "project"));

  assert.match(r.stdout, /root "project" binds to/,
    `sliceRoot must still bind the "project" kind.\n--- stdout ---\n${r.stdout}`);
  assert.equal(r.status, 0, `legacy binding must not regress.\n--- stdout ---\n${r.stdout}`);
});

test("STILL REFUSES: a declared kind with no binding is a refusal, not a silent install", () => {
  const dir = tmp();
  const studio = makeStudio(dir, {
    apps: [],
    appsRoot: path.join(dir, "studio", "apps"),
    roots: { fleet: path.join(dir, "somewhere") },
  });
  // Declares a kind the box binds nothing for. Opening the vocabulary must not
  // turn this into an accept.
  const r = install(studio, makeApp(dir, "telemetry"));

  assert.match(r.stdout, /root "telemetry" has no binding/,
    `an unbound kind must still refuse.\n--- stdout ---\n${r.stdout}`);
  assert.notEqual(r.status, 0, "an unbound root must fail the install");
  // And the refusal must name WHERE to bind it, or the operator is told a fact
  // without being told the shape that accepts it.
  assert.match(r.stdout + (r.stderr ?? ""), /roots\.telemetry|roots\b/,
    `the refusal should name the studio.json key that would bind it.\n--- stdout ---\n${r.stdout}`);
});
