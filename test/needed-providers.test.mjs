// Which providers an app set actually needs.
//
//   node --test 'test/*.test.mjs'
//
// Provisioning installed dependencies for EVERY provider on disk regardless of
// which apps were enabled, so a provider nobody asked for could stop the whole
// install — which is exactly what happened on a real VPS. It also made the curated
// app default a half-truth: choosing four apps still installed all seven
// providers, so "two providers, no ffmpeg" described the app list rather than what
// landed on the box.
//
// Found and reported by cloud-impl. The under-installing direction matters as much
// as the over-installing one, so both are pinned here: a set that is too NARROW
// fails at reconciliation with a named error, which is loud; a set that is too WIDE
// fails by dragging in a provider nobody wanted, which is what blocked the box.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "provision", "needed-providers.mjs");

function fixture(apps, providers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "needprov-"));
  for (const [id, manifest] of Object.entries(apps)) {
    const d = path.join(root, "apps", id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "app.json"), JSON.stringify(manifest, null, 2));
  }
  for (const [id, decl] of Object.entries(providers)) {
    const d = path.join(root, "providers", id);
    fs.mkdirSync(d, { recursive: true });
    if (decl) fs.writeFileSync(path.join(d, "provider.json"), JSON.stringify(decl, null, 2));
  }
  return root;
}
const run = (root, ...apps) =>
  execFileSync(process.execPath, [SCRIPT, root, ...apps], { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);

const PROVIDERS = {
  "studio-host": { package: "@openrig/studio-host", verbs: ["/api/files/tree"] },
  "studio-factory": { package: "@openrig/studio-factory", verbs: ["/api/factory/state"] },
  "studio-video": { package: "@openrig/studio-video", verbs: ["/api/clips"] },
  "studio-effects": { package: "@openrig/studio-effects", verbs: ["/api/effects"] },
};

test("an app that NAMES a provider pulls exactly that one", () => {
  const root = fixture({ files: { id: "files", provider: { package: "@openrig/studio-host" } } }, PROVIDERS);
  assert.deepEqual(run(root, "files"), ["studio-host"]);
});

test("an app that declares NO provider pulls nothing", () => {
  // The workspace shape: `required: false` with no package, deliberately.
  const root = fixture({
    workspace: { id: "workspace", provider: { required: false, _note: "no backend on purpose" } },
    designer: { id: "designer" },
  }, PROVIDERS);
  assert.deepEqual(run(root, "workspace", "designer"), [],
    "an app with no backend dragged a provider install onto the box");
});

test("THE WHOLE POINT: a narrow app set does not pull every provider on disk", () => {
  const root = fixture({
    workspace: { id: "workspace", provider: { required: false } },
    files: { id: "files", provider: { package: "@openrig/studio-host" } },
    factory: { id: "factory", provider: { package: "@openrig/studio-factory" } },
    cutdown: { id: "cutdown", provider: { package: "@openrig/studio-video" } },
    gallery: { id: "gallery", provider: { package: "@openrig/studio-effects" } },
  }, PROVIDERS);
  const got = run(root, "workspace", "files", "factory");
  assert.deepEqual(got, ["studio-factory", "studio-host"]);
  assert.ok(!got.includes("studio-video") && !got.includes("studio-effects"),
    "a provider no enabled app references would still have its dependencies installed, and could still stop the box");
});

test("a REQUIRED cross-provider call pulls the provider that answers it", () => {
  // `calls` is provider-agnostic by design, so an app can require a verb another
  // backend serves. Under-installing that is not merely tidy — the provider cannot
  // start, so the verb is unserved and reconciliation refuses the install.
  const root = fixture({
    agents: { id: "agents", calls: { "/api/factory/state": { required: true } } },
  }, PROVIDERS);
  assert.deepEqual(run(root, "agents"), ["studio-factory"]);
});

test("an OPTIONAL call pulls nothing — required:false grants no authority", () => {
  // Mirrors the unmatched-call ladder in app-manifest.md: only `required: true`
  // may start a provider no app names as its own, so only it may install one.
  const root = fixture({
    agents: { id: "agents", calls: { "/api/factory/state": { required: false } } },
  }, PROVIDERS);
  assert.deepEqual(run(root, "agents"), []);
});

test("a PREFIX verb declaration still matches", () => {
  // app-manifest.md: a verb ending in `/` is a prefix, so an exact-key lookup
  // alone silently misses `/api/export-status/<jobId>`.
  const root = fixture(
    { j: { id: "j", calls: { "/api/export-status/42": { required: true } } } },
    { ...PROVIDERS, "studio-jobs": { package: "@openrig/studio-jobs", verbs: ["/api/export-status/"] } });
  assert.deepEqual(run(root, "j"), ["studio-jobs"]);
});

test("a provider NAMED but absent from disk is not invented", () => {
  // Reconciliation names a missing provider with a proper error; this script's job
  // is to say what to install, and it cannot install what is not there.
  const root = fixture({ x: { id: "x", provider: { package: "@openrig/studio-ghost" } } }, PROVIDERS);
  assert.deepEqual(run(root, "x"), []);
});

test("positive control: the fixture CAN produce every provider", () => {
  // Without this, every assertion above would also pass against a script that
  // always returned an empty list.
  const root = fixture({
    a: { id: "a", provider: { package: "@openrig/studio-host" } },
    b: { id: "b", provider: { package: "@openrig/studio-factory" } },
    c: { id: "c", provider: { package: "@openrig/studio-video" } },
    d: { id: "d", provider: { package: "@openrig/studio-effects" } },
  }, PROVIDERS);
  assert.deepEqual(run(root, "a", "b", "c", "d"),
    ["studio-effects", "studio-factory", "studio-host", "studio-video"]);
});
