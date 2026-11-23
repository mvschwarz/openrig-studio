// An app added to a release-managed workspace is the workspace's own code.
//
// WHY THIS EXISTS. On a workspace installed by tools/studio-release.mjs, its own
// apps and providers live in extensions/apps|providers and every apply links them
// into the new code generation. Two defects made that path unusable after install,
// both reproduced against the shipped tools before this file was written:
//   1. same-release apply: plan listed a newly added extension, apply answered
//      "done, noop" and nothing was linked, so plan and apply disagreed;
//   2. tools/install-app.mjs copied the app into appsRoot, which on a managed
//      workspace is the generated vendor tree, where inspect reports it as
//      "added" vendor drift and the next upgrade drops it.
// These tests start from those two cases and then pin what must not change.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "../lib/releases/manifest.mjs";
import {
  planRelease,
  applyRelease,
  inspectWorkspace,
  rollbackWorkspace,
} from "../lib/releases/workspace.mjs";

const INSTALLER = fileURLToPath(new URL("../tools/install-app.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "custom-app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace: path.join(root, "workspace") };
}
function release(root, number) {
  const dir = path.join(root, "r" + number);
  fs.mkdirSync(dir);
  const components = {};
  const sets = {
    studioSdk: { "app/shell.html": "shell" + number, "package.json": '{"name":"@openrig/studio"}' },
    studioApps: {
      "apps/files/app.json": '{"id":"files"}',
      "apps/files/app/files.html": "vendor" + number,
      "apps/files/app/help.html": "help" + number,
    },
  };
  for (const [id, files] of Object.entries(sets)) {
    const baseline = Object.entries(files)
      .map(([p, b]) => sha256(Buffer.from(b)) + "  " + p + "\n")
      .join("");
    fs.writeFileSync(path.join(dir, id + ".sha256"), baseline);
    const archive = path.join(dir, id + ".tar.gz");
    const p = spawnSync(
      "python3",
      [
        "-c",
        "import sys,tarfile,json,io\nf=json.load(sys.stdin)\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n for p,s in f.items():\n  b=s.encode();i=tarfile.TarInfo(p);i.size=len(b);i.mode=0o644;t.addfile(i,io.BytesIO(b))",
        archive,
      ],
      { input: JSON.stringify(files), encoding: "utf8" },
    );
    assert.equal(p.status, 0, p.stderr);
    const bytes = fs.readFileSync(archive);
    components[id] = {
      name: id === "studioSdk" ? "@openrig/studio" : "@openrig/studio-apps",
      version: id === "studioSdk" ? "0.8.1-pre.1+variant.2" : "0.1." + number,
      artifact: { file: path.basename(archive), sha256: sha256(bytes), bytes: bytes.length },
      source: { repo: "fixture", rev: "a".repeat(40) },
      vendorBaseline: { file: id + ".sha256", sha256: sha256(Buffer.from(baseline)) },
      ...(id === "studioSdk"
        ? { interfaces: { studioContract: "v0.1" } }
        : { requires: { studioSdk: ">=0.8.1-pre.1 <0.9.0", studioContract: "v0.1" } }),
    };
  }
  const d = {
    schema: "openrig.release/v0",
    release: `2026.11.${number}-pre.1`,
    line: "pre-1.0",
    compatibility: {
      policy: "fixture",
      upgradeFrom: number ? [`2026.11.${number - 1}-pre.1`] : [],
      adoptUnversioned: true,
    },
    components,
    customerOwned: ["studio.json", "extensions", "project", "data"],
    migrations: [],
  };
  const file = path.join(dir, d.release + ".json");
  fs.writeFileSync(file, JSON.stringify(d));
  return { file, descriptor: d, dir };
}
function app(dir, id, body = id + "-v1", extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "app.json"),
    JSON.stringify({
      id,
      name: id.toUpperCase(),
      surface: { entry: "index.html", path: `/surfaces/${id}.html` },
      ...extra,
    }),
  );
  fs.writeFileSync(path.join(dir, "index.html"), body);
  return dir;
}
function provider(dir, pkg, verb) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "provider.json"),
    JSON.stringify({ package: pkg, run: { entry: "server.mjs" }, verbs: [verb] }),
  );
  fs.writeFileSync(
    path.join(dir, "server.mjs"),
    "// fixture provider; never started by these tests\n",
  );
  return dir;
}
function managed(t, config = { apps: ["files"], custom: "kept", roots: { project: "project" } }) {
  const f = fixture(t),
    r0 = release(f.root, 0);
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file, config }).outcome, "done");
  fs.mkdirSync(path.join(f.workspace, "project"));
  fs.writeFileSync(path.join(f.workspace, "project/saved.json"), '{"kept":true}');
  return { ...f, r0 };
}
const install = (studio, args) =>
  spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, OPENRIG_STUDIO_DIR: studio },
    encoding: "utf8",
  });
const owned = (ws) =>
  Object.fromEntries(
    ["studio.json", "project/saved.json"].map((p) => [
      p,
      fs.readFileSync(path.join(ws, p), "utf8"),
    ]),
  );
const linkOf = (generation, p) => {
  const l = path.join(generation, "studioApps", p);
  return fs.lstatSync(l, { throwIfNoEntry: false })?.isSymbolicLink() ? fs.realpathSync(l) : null;
};

test("NEGATIVE PARENT 1: a same-release apply links a newly added extension instead of answering a false noop", (t) => {
  const f = managed(t),
    before = inspectWorkspace(f.workspace).generation;
  const sticky = app(path.join(f.workspace, "extensions/apps/sticky"), "sticky");
  const plan = planRelease({ workspace: f.workspace, release: f.r0.file }).plan;
  assert.equal(plan.supported, true);
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.extensionChanges, { added: ["apps/sticky"], removed: [], relinked: [] });
  assert.deepEqual(plan.restart, ["studioApps"]);
  const applied = applyRelease({ workspace: f.workspace, release: f.r0.file });
  assert.equal(applied.outcome, "done");
  assert.notEqual(applied.noop, true);
  const now = inspectWorkspace(f.workspace);
  assert.notEqual(now.generation, before);
  assert.equal(now.release, f.r0.descriptor.release);
  assert.equal(linkOf(now.generation, "apps/sticky"), fs.realpathSync(sticky));
  assert.deepEqual(now.extensions.pending, { added: [], removed: [], relinked: [] });
  assert.ok(now.extensions.mounted.includes("apps/sticky"));
  assert.deepEqual(now.drift, []);
  // The previous generation is untouched and is what rollback returns to.
  assert.equal(linkOf(before, "apps/sticky"), null);
  assert.equal(rollbackWorkspace(f.workspace).release, f.r0.descriptor.release);
  assert.equal(inspectWorkspace(f.workspace).generation, before);
  assert.deepEqual(inspectWorkspace(f.workspace).extensions.pending.added, ["apps/sticky"]);
});

test("an unchanged extension set is still a real noop and writes nothing", (t) => {
  const f = managed(t);
  app(path.join(f.workspace, "extensions/apps/sticky"), "sticky");
  applyRelease({ workspace: f.workspace, release: f.r0.file });
  const generation = inspectWorkspace(f.workspace).generation,
    releases = fs.readdirSync(path.join(f.workspace, ".studio-release/releases"));
  const plan = planRelease({ workspace: f.workspace, release: f.r0.file }).plan;
  assert.deepEqual(plan.extensionChanges, { added: [], removed: [], relinked: [] });
  assert.deepEqual(plan.restart, []);
  const again = applyRelease({ workspace: f.workspace, release: f.r0.file });
  assert.equal(again.noop, true);
  assert.equal(inspectWorkspace(f.workspace).generation, generation);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace, ".studio-release/releases")), releases);
});

test("a relink keeps local vendor edits, deletions and modes exactly, without asking for --keep-local", (t) => {
  const f = managed(t),
    old = inspectWorkspace(f.workspace).generation;
  fs.writeFileSync(path.join(old, "studioApps/apps/files/app/files.html"), "local-patch");
  fs.unlinkSync(path.join(old, "studioApps/apps/files/app/help.html"));
  fs.chmodSync(path.join(old, "studioSdk/app/shell.html"), 0o664);
  const driftBefore = inspectWorkspace(f.workspace).drift,
    ownedBefore = owned(f.workspace);
  assert.equal(driftBefore.length, 3);
  app(path.join(f.workspace, "extensions/apps/sticky"), "sticky");
  assert.equal(applyRelease({ workspace: f.workspace, release: f.r0.file }).outcome, "done");
  const now = inspectWorkspace(f.workspace);
  assert.notEqual(now.generation, old);
  assert.equal(
    fs.readFileSync(path.join(now.generation, "studioApps/apps/files/app/files.html"), "utf8"),
    "local-patch",
  );
  assert.equal(
    fs.existsSync(path.join(now.generation, "studioApps/apps/files/app/help.html")),
    false,
  );
  assert.equal(
    fs.statSync(path.join(now.generation, "studioSdk/app/shell.html")).mode & 0o777,
    0o664,
  );
  assert.deepEqual(now.drift, driftBefore);
  assert.deepEqual(owned(f.workspace), ownedBefore);
});

test("a removed extension is unlinked, and a replacement of a shipped app still needs --keep-local", (t) => {
  const f = managed(t);
  const sticky = app(path.join(f.workspace, "extensions/apps/sticky"), "sticky");
  applyRelease({ workspace: f.workspace, release: f.r0.file });
  fs.rmSync(sticky, { recursive: true });
  assert.deepEqual(
    planRelease({ workspace: f.workspace, release: f.r0.file }).plan.extensionChanges.removed,
    ["apps/sticky"],
  );
  assert.equal(applyRelease({ workspace: f.workspace, release: f.r0.file }).outcome, "done");
  const now = inspectWorkspace(f.workspace);
  assert.equal(
    fs.lstatSync(path.join(now.generation, "studioApps/apps/sticky"), { throwIfNoEntry: false }),
    undefined,
  );
  assert.equal(now.extensions.mounted.includes("apps/sticky"), false);
  app(path.join(f.workspace, "extensions/apps/files"), "files", "local files app");
  const refused = applyRelease({ workspace: f.workspace, release: f.r0.file });
  assert.equal(refused.outcome, "refused");
  assert.match(refused.reason, /keep-local/);
  assert.equal(inspectWorkspace(f.workspace).generation, now.generation);
  assert.equal(
    applyRelease({ workspace: f.workspace, release: f.r0.file, keepLocal: true }).outcome,
    "done",
  );
  assert.equal(
    fs.readFileSync(
      path.join(inspectWorkspace(f.workspace).generation, "studioApps/apps/files/index.html"),
      "utf8",
    ),
    "local files app",
  );
});

test("a later upgrade keeps a registered extension linked and workspace files unchanged", (t) => {
  const f = managed(t);
  const sticky = app(path.join(f.workspace, "extensions/apps/sticky"), "sticky");
  applyRelease({ workspace: f.workspace, release: f.r0.file });
  const ownedBefore = owned(f.workspace),
    r1 = release(f.root, 1);
  const plan = planRelease({ workspace: f.workspace, release: r1.file }).plan;
  assert.deepEqual(plan.extensionChanges, { added: [], removed: [], relinked: [] });
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "done");
  const now = inspectWorkspace(f.workspace);
  assert.equal(now.release, r1.descriptor.release);
  assert.equal(linkOf(now.generation, "apps/sticky"), fs.realpathSync(sticky));
  assert.equal(
    fs.readFileSync(path.join(now.generation, "studioApps/apps/files/app/files.html"), "utf8"),
    "vendor1",
  );
  assert.deepEqual(owned(f.workspace), ownedBefore);
});

test("NEGATIVE PARENT 2: install-app on a managed workspace writes workspace-owned extensions, links them, and enables the app", (t) => {
  const f = managed(t),
    appsRoot = JSON.parse(fs.readFileSync(path.join(f.workspace, "studio.json"))).appsRoot;
  const src = app(path.join(f.root, "src/notes"), "notes", "notes-v1", {
    provider: { package: "@example/notes-provider", required: true },
  });
  const prov = provider(
    path.join(f.root, "src/notes-provider"),
    "@example/notes-provider",
    "/api/notes/list",
  );
  const r = install(f.workspace, [src, "--provider", prov, "--enable"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Workspace-owned copies, not files written into the generated vendor tree.
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "extensions/apps/notes/index.html"), "utf8"),
    "notes-v1",
  );
  assert.ok(
    fs.existsSync(path.join(f.workspace, "extensions/providers/notes-provider/provider.json")),
  );
  const now = inspectWorkspace(f.workspace);
  assert.equal(
    linkOf(now.generation, "apps/notes"),
    fs.realpathSync(path.join(f.workspace, "extensions/apps/notes")),
  );
  assert.equal(
    linkOf(now.generation, "providers/notes-provider"),
    fs.realpathSync(path.join(f.workspace, "extensions/providers/notes-provider")),
  );
  assert.deepEqual(now.drift, []);
  const config = JSON.parse(fs.readFileSync(path.join(f.workspace, "studio.json")));
  assert.deepEqual(config.apps, ["files", "notes"]);
  assert.equal(config.custom, "kept");
  assert.equal(config.appsRoot, appsRoot);
  // Registration is not activation, and the tool says which one it did.
  assert.match(r.stdout, /registered/i);
  assert.match(r.stdout, /not (yet )?active/i);
});

test("a managed update replaces the app in place, keeps it linked and leaves other apps alone", (t) => {
  const f = managed(t);
  app(path.join(f.workspace, "extensions/apps/other"), "other", "other-untouched");
  const src = app(path.join(f.root, "src/notes"), "notes", "notes-v1");
  assert.equal(install(f.workspace, [src, "--enable"]).status, 0);
  const generation = inspectWorkspace(f.workspace).generation;
  fs.writeFileSync(path.join(src, "index.html"), "notes-v2");
  assert.equal(
    install(f.workspace, [src]).status,
    1,
    "replacing needs --force, as on an unmanaged studio",
  );
  const r = install(f.workspace, [src, "--force"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const now = inspectWorkspace(f.workspace);
  assert.equal(now.generation, generation, "an in-place update needs no new generation");
  assert.equal(
    fs.readFileSync(path.join(now.generation, "studioApps/apps/notes/index.html"), "utf8"),
    "notes-v2",
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "extensions/apps/other/index.html"), "utf8"),
    "other-untouched",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.workspace, "studio.json"))).apps, [
    "files",
    "notes",
  ]);
  assert.match(r.stdout, /updated/i);
});

test("a managed install that fails validation writes nothing", (t) => {
  const f = managed(t),
    generation = inspectWorkspace(f.workspace).generation,
    config = fs.readFileSync(path.join(f.workspace, "studio.json"));
  const bad = path.join(f.root, "src/bad");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(
    path.join(bad, "app.json"),
    JSON.stringify({
      id: "bad",
      name: "BAD",
      surface: { entry: "missing.html", path: "/surfaces/bad.html" },
    }),
  );
  const r = install(f.workspace, [bad, "--enable"]);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(f.workspace, "extensions")), false);
  assert.equal(inspectWorkspace(f.workspace).generation, generation);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, "studio.json")), config);
});

test("an unmanaged studio keeps the existing install into appsRoot", (t) => {
  const f = fixture(t),
    studio = path.join(f.root, "studio");
  fs.mkdirSync(studio);
  fs.writeFileSync(
    path.join(studio, "studio.json"),
    JSON.stringify({ apps: [], appsRoot: path.join(studio, "apps") }),
  );
  const r = install(studio, [app(path.join(f.root, "src/notes"), "notes"), "--enable"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    fs.readFileSync(path.join(studio, "apps/apps/notes/index.html"), "utf8"),
    "notes-v1",
  );
  assert.equal(fs.existsSync(path.join(studio, "extensions")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(studio, "studio.json"))).apps, ["notes"]);
});

// THE REGISTRATION SIGNAL, agreed with the runtime owner: one atomic file that a
// runtime can watch, a marker that changes on every recorded change, written only
// after success. Activation is the runtime's own report, matched by marker.
const record = (ws) =>
  JSON.parse(fs.readFileSync(path.join(ws, ".studio-release/extensions.json"), "utf8"));
test("extensions.json records every registration change with a new marker; rollback and removal too", (t) => {
  const f = managed(t),
    src = app(path.join(f.root, "src/notes"), "notes", "notes-v1");
  assert.equal(install(f.workspace, [src, "--enable"]).status, 0);
  const r1 = record(f.workspace),
    gen1 = inspectWorkspace(f.workspace).generation;
  assert.equal(r1.schema, "openrig.extensions-state/v0");
  assert.equal(r1.generation, gen1);
  assert.equal(r1.last.kind, "registered");
  const notes1 = r1.mounted.find((m) => m.path === "apps/notes");
  assert.ok(notes1?.contentSha256);
  assert.equal(notes1.source, fs.realpathSync(path.join(f.workspace, "extensions/apps/notes")));
  fs.writeFileSync(path.join(src, "index.html"), "notes-v2");
  assert.equal(install(f.workspace, [src, "--force"]).status, 0);
  const r2 = record(f.workspace);
  assert.notEqual(r2.marker, r1.marker);
  assert.equal(r2.last.kind, "updated");
  assert.equal(r2.generation, gen1);
  assert.notEqual(
    r2.mounted.find((m) => m.path === "apps/notes").contentSha256,
    notes1.contentSha256,
  );
  fs.rmSync(path.join(f.workspace, "extensions/apps/notes"), { recursive: true });
  assert.equal(applyRelease({ workspace: f.workspace, release: f.r0.file }).outcome, "done");
  const r3 = record(f.workspace);
  assert.notEqual(r3.marker, r2.marker);
  assert.equal(r3.last.kind, "removed");
  assert.equal(
    r3.mounted.some((m) => m.path === "apps/notes"),
    false,
  );
  assert.equal(rollbackWorkspace(f.workspace).outcome, "done");
  const r4 = record(f.workspace);
  assert.notEqual(r4.marker, r3.marker);
  assert.equal(r4.last.kind, "rollback");
  assert.ok(r4.mounted.some((m) => m.path === "apps/notes"));
  // A noop records nothing.
  const bytes = fs.readFileSync(path.join(f.workspace, ".studio-release/extensions.json"));
  app(path.join(f.workspace, "extensions/apps/notes"), "notes");
  assert.equal(applyRelease({ workspace: f.workspace, release: f.r0.file }).noop, true);
  assert.deepEqual(
    fs.readFileSync(path.join(f.workspace, ".studio-release/extensions.json")),
    bytes,
  );
});

test("a refused managed install restores the previous files and keeps the previous record", (t) => {
  const f = managed(t);
  assert.equal(
    install(f.workspace, [app(path.join(f.root, "src/notes"), "notes"), "--enable"]).status,
    0,
  );
  const bytes = fs.readFileSync(path.join(f.workspace, ".studio-release/extensions.json")),
    generation = inspectWorkspace(f.workspace).generation,
    config = fs.readFileSync(path.join(f.workspace, "studio.json"));
  // An app named like a shipped app shadows it; without --keep-local the relink refuses.
  const r = install(f.workspace, [
    app(path.join(f.root, "src/files"), "files", "local files"),
    "--enable",
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /keep-local/);
  assert.equal(fs.existsSync(path.join(f.workspace, "extensions/apps/files")), false);
  assert.equal(inspectWorkspace(f.workspace).generation, generation);
  assert.deepEqual(
    fs.readFileSync(path.join(f.workspace, ".studio-release/extensions.json")),
    bytes,
  );
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, "studio.json")), config);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace, "extensions/apps")), ["notes"]);
});

test("inspect reports the runtime's activation only for the matching marker, and never as live health", (t) => {
  const f = managed(t);
  assert.equal(
    install(f.workspace, [app(path.join(f.root, "src/notes"), "notes"), "--enable"]).status,
    0,
  );
  const rec = record(f.workspace);
  assert.equal(inspectWorkspace(f.workspace).extensions.activation.state, "not-reported");
  fs.mkdirSync(path.join(f.workspace, ".runtime"), { recursive: true });
  const status = (marker, state) =>
    fs.writeFileSync(
      path.join(f.workspace, ".runtime/extensions-status.json"),
      JSON.stringify({
        schema: "openrig.extensions-activation/v0",
        marker,
        generation: rec.generation,
        state,
        at: new Date().toISOString(),
        pid: 1,
      }),
    );
  status("some-older-marker", "active");
  assert.equal(inspectWorkspace(f.workspace).extensions.activation.state, "not-reported");
  status(rec.marker, "active");
  const a = inspectWorkspace(f.workspace).extensions.activation;
  assert.equal(a.state, "active");
  assert.equal(a.marker, rec.marker);
  assert.equal(a.liveHealth, "not-checked");
  status(rec.marker, "failed");
  assert.equal(inspectWorkspace(f.workspace).extensions.activation.state, "failed");
  // A new registration makes the old report stale again.
  assert.equal(
    install(f.workspace, [app(path.join(f.root, "src/other"), "other"), "--enable"]).status,
    0,
  );
  assert.equal(inspectWorkspace(f.workspace).extensions.activation.state, "not-reported");
});

// The record a runtime reacts to must be written AFTER --enable (so it already sees
// the enabled app), and an unmanaged studio emits the same record.
test("the registration record is written after --enable, so its marker already sees the enabled app", (t) => {
  const f = managed(t);
  assert.equal(
    install(f.workspace, [app(path.join(f.root, "src/notes"), "notes"), "--enable"]).status,
    0,
  );
  const rec = record(f.workspace),
    recMtime = fs.statSync(path.join(f.workspace, ".studio-release/extensions.json")).mtimeMs,
    cfgMtime = fs.statSync(path.join(f.workspace, "studio.json")).mtimeMs;
  assert.ok(recMtime >= cfgMtime, "extensions.json must not be older than the enabled studio.json");
  assert.equal(rec.last.enabled, true);
  assert.equal(rec.last.kind, "registered");
  assert.equal(rec.managed, true);
});

test("an unmanaged install and update emit the same record with generation null", (t) => {
  const f = fixture(t),
    studio = path.join(f.root, "studio");
  fs.mkdirSync(studio);
  fs.writeFileSync(
    path.join(studio, "studio.json"),
    JSON.stringify({ apps: [], appsRoot: path.join(studio, "apps") }),
  );
  const src = app(path.join(f.root, "src/notes"), "notes");
  assert.equal(install(studio, [src, "--enable"]).status, 0);
  const r1 = record(studio),
    notes = r1.mounted.find((m) => m.path === "apps/notes");
  assert.equal(r1.schema, "openrig.extensions-state/v0");
  assert.equal(r1.generation, null);
  assert.equal(r1.managed, false);
  assert.equal(notes.source, fs.realpathSync(path.join(studio, "apps/apps/notes")));
  assert.ok(notes.contentSha256);
  assert.equal(r1.last.kind, "registered");
  assert.equal(r1.last.enabled, true);
  assert.ok(
    fs.statSync(path.join(studio, ".studio-release/extensions.json")).mtimeMs >=
      fs.statSync(path.join(studio, "studio.json")).mtimeMs,
  );
  // Still an unmanaged studio: no release state was invented.
  assert.equal(inspectWorkspace(studio).outcome, "unversioned");
  fs.writeFileSync(path.join(src, "index.html"), "notes-v2");
  assert.equal(install(studio, [src, "--force"]).status, 0);
  const r2 = record(studio);
  assert.notEqual(r2.marker, r1.marker);
  assert.equal(r2.last.kind, "updated");
  assert.notEqual(
    r2.mounted.find((m) => m.path === "apps/notes").contentSha256,
    notes.contentSha256,
  );
});

// A read-only vendor directory (0555) must not stop a relink: the copy sets a
// directory's mode only after filling it.
test("a relink copies a read-only vendor directory and keeps its mode", (t) => {
  const f = managed(t),
    old = inspectWorkspace(f.workspace).generation,
    ro = path.join(old, "studioApps/apps/files/app");
  let copied = null;
  fs.chmodSync(ro, 0o555);
  try {
    app(path.join(f.workspace, "extensions/apps/sticky"), "sticky");
    const r = applyRelease({ workspace: f.workspace, release: f.r0.file });
    assert.equal(r.outcome, "done", r.reason);
    const now = inspectWorkspace(f.workspace);
    assert.ok(now.extensions.mounted.includes("apps/sticky"));
    copied = path.join(now.generation, "studioApps/apps/files/app");
    assert.equal(fs.statSync(copied).mode & 0o777, 0o555);
    assert.equal(fs.readFileSync(path.join(copied, "files.html"), "utf8"), "vendor0");
  } finally {
    for (const d of [ro, copied])
      if (d)
        try {
          fs.chmodSync(d, 0o755);
        } catch {}
  } // so the fixture can be removed
});
