import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  applyRelease,
  inspectWorkspace,
  planRelease,
  rollbackWorkspace,
} from "../lib/releases/workspace.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  TOOL = process.env.STUDIO_RELEASE_TEST_CLI;
function call(verb, options) {
  if (!TOOL)
    return verb === "inspect"
      ? inspectWorkspace(options.workspace)
      : verb === "rollback"
        ? rollbackWorkspace(options.workspace)
        : verb === "plan"
          ? planRelease(options).plan
          : applyRelease(options);
  const args = [TOOL, verb];
  for (const [k, v] of Object.entries(options)) {
    const name = {
      workspace: "workspace",
      release: "release",
      baseline: "baseline",
      adoptSdk: "adopt-sdk",
      adoptApps: "adopt-apps",
      keepLocal: "keep-local",
    }[k];
    assert.ok(name, k);
    args.push("--" + name);
    if (k !== "keepLocal") args.push(v);
  }
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
function release(root, n, remove = false, retype = false) {
  const dir = path.join(root, "r" + n);
  fs.mkdirSync(dir);
  const components = {};
  const payloads = {
    studioSdk: {
      "lib/version.txt": ["vendor-" + n, 0o600],
      "bin/runner": ["#!/bin/sh\nprintf vendor-" + n, 0o700],
      "lib/to-file/child": ["child-" + n, 0o600],
      "lib/to-dir": ["leaf-" + n, 0o600],
    },
    studioApps: {
      "apps/sample/app.json": ['{"id":"sample"}', 0o600],
      "apps/sample/view.js": ["app-" + n, 0o600],
    },
  };
  if (remove) delete payloads.studioSdk["lib/version.txt"];
  if (retype) {
    delete payloads.studioSdk["lib/to-file/child"];
    delete payloads.studioSdk["lib/to-dir"];
    payloads.studioSdk["lib/to-file"] = ["new leaf", 0o644];
    payloads.studioSdk["lib/to-dir/child"] = ["new child", 0o644];
  }
  for (const [id, files] of Object.entries(payloads)) {
    const archive = path.join(dir, id + ".tgz"),
      r = spawnSync(
        "python3",
        [
          "-c",
          "import tarfile,io,json,sys\nf=json.load(sys.stdin)\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n for p,(s,m) in f.items():\n  b=s.encode();i=tarfile.TarInfo(p);i.mode=m;i.size=len(b);t.addfile(i,io.BytesIO(b))",
          archive,
        ],
        { input: JSON.stringify(files), encoding: "utf8" },
      );
    assert.equal(r.status, 0, r.stderr);
    const b = fs.readFileSync(archive),
      manifest = Object.entries(files)
        .map(([p, [s]]) => hash(Buffer.from(s)) + "  " + p + "\n")
        .join("");
    fs.writeFileSync(path.join(dir, id + ".sha256"), manifest);
    components[id] = {
      name: id === "studioSdk" ? "@openrig/studio" : "@openrig/studio-apps",
      version: id === "studioSdk" ? "0.8.1-pre." + (n + 1) : "0.1." + n,
      artifact: { file: path.basename(archive), sha256: hash(b), bytes: b.length },
      vendorBaseline: { file: id + ".sha256", sha256: hash(Buffer.from(manifest)) },
      source: { repo: "fixture", rev: String(n + 1).repeat(40) },
    };
  }
  const d = {
      schema: "openrig.release/v0",
      release: "1.0." + n,
      line: "pre-1.0",
      compatibility: {
        policy: "fixture",
        upgradeFrom: n ? ["1.0." + (n - 1)] : [],
        adoptUnversioned: true,
      },
      components,
      customerOwned: ["studio.json", "project", "extensions"],
      migrations: [],
    },
    file = path.join(dir, "release.json");
  fs.writeFileSync(file, JSON.stringify(d));
  return { file, d };
}
function fixture(t, adopt = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-modes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = release(root, 0),
    next = release(root, 1),
    seed = path.join(root, "seed");
  call("apply", { workspace: seed, release: old.file });
  const original = call("inspect", { workspace: seed }).generation;
  let workspace = seed,
    options = {};
  if (adopt) {
    workspace = path.join(root, "legacy");
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      path.join(workspace, "studio.json"),
      JSON.stringify({
        apps: ["sample"],
        appsRoot: path.join(original, "studioApps"),
        other: "kept",
      }),
    );
    options = {
      baseline: old.file,
      adoptSdk: path.join(original, "studioSdk"),
      adoptApps: path.join(original, "studioApps"),
    };
  }
  return { root, old, next, original, workspace, options };
}
function modeOnly(f) {
  for (const [p, m] of [
    ["studioSdk/lib/version.txt", 0o664],
    ["studioSdk/bin/runner", 0o775],
    ["studioApps/apps/sample/view.js", 0o664],
  ])
    fs.chmodSync(path.join(f.original, p), m);
}
for (const adopt of [false, true])
  test(`${adopt ? "adoption" : "managed upgrade"} keeps incoming bytes and explicit local permissions, including executability`, (t) => {
    const f = fixture(t, adopt);
    modeOnly(f);
    const options = { workspace: f.workspace, release: f.next.file, ...f.options, keepLocal: true },
      plan = call("plan", options);
    call("apply", options);
    const now = call("inspect", { workspace: f.workspace }),
      sdk = path.join(now.generation, "studioSdk");
    assert.equal(fs.readFileSync(path.join(sdk, "lib/version.txt"), "utf8"), "vendor-1");
    assert.equal(execFileSync(path.join(sdk, "bin/runner"), { encoding: "utf8" }), "vendor-1");
    assert.equal(fs.statSync(path.join(sdk, "lib/version.txt")).mode & 0o777, 0o664);
    assert.equal(fs.statSync(path.join(sdk, "bin/runner")).mode & 0o777, 0o775);
    assert.equal(
      fs.readFileSync(path.join(now.generation, "studioApps/apps/sample/view.js"), "utf8"),
      "app-1",
    );
    assert.ok(plan.drift.every((d) => d.kind === "mode-only"));
    assert.equal(now.components.studioSdk.source.rev, "2".repeat(40));
    assert.ok(now.drift.every((d) => d.kind === "mode-only"));
    assert.equal(now.effective.state, "unknown");
  });
test("real local content edits and deliberate deletion still survive; explicit rollback keeps the original generation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.original, "studioSdk/lib/version.txt"), "my actual edit");
  fs.chmodSync(path.join(f.original, "studioSdk/lib/version.txt"), 0o664);
  fs.unlinkSync(path.join(f.original, "studioApps/apps/sample/view.js"));
  call("apply", { workspace: f.workspace, release: f.next.file, keepLocal: true });
  const now = call("inspect", { workspace: f.workspace });
  assert.equal(
    fs.readFileSync(path.join(now.generation, "studioSdk/lib/version.txt"), "utf8"),
    "my actual edit",
  );
  assert.equal(fs.existsSync(path.join(now.generation, "studioApps/apps/sample/view.js")), false);
  assert.equal(
    execFileSync(path.join(now.generation, "studioSdk/bin/runner"), { encoding: "utf8" }),
    "vendor-1",
  );
  call("rollback", { workspace: f.workspace });
  assert.equal(call("inspect", { workspace: f.workspace }).generation, f.original);
  assert.equal(
    fs.readFileSync(path.join(f.original, "studioSdk/lib/version.txt"), "utf8"),
    "my actual edit",
  );
});
test("mode-only drift never resurrects a vendor file removed by the incoming release", (t) => {
  const f = fixture(t),
    removed = release(f.root, 2, true);
  removed.d.compatibility.upgradeFrom = [f.old.d.release];
  fs.writeFileSync(removed.file, JSON.stringify(removed.d));
  fs.chmodSync(path.join(f.original, "studioSdk/lib/version.txt"), 0o664);
  call("apply", { workspace: f.workspace, release: removed.file, keepLocal: true });
  const now = call("inspect", { workspace: f.workspace });
  assert.equal(fs.existsSync(path.join(now.generation, "studioSdk/lib/version.txt")), false);
  assert.equal(
    execFileSync(path.join(now.generation, "studioSdk/bin/runner"), { encoding: "utf8" }),
    "vendor-2",
  );
});

test("permissions do not restore old descendants when an incoming release changes file and directory types", (t) => {
  const f = fixture(t),
    next = release(f.root, 2, false, true);
  next.d.compatibility.upgradeFrom = [f.old.d.release];
  fs.writeFileSync(next.file, JSON.stringify(next.d));
  fs.chmodSync(path.join(f.original, "studioSdk/lib/to-file/child"), 0o664);
  fs.chmodSync(path.join(f.original, "studioSdk/lib/to-dir"), 0o664);
  call("apply", { workspace: f.workspace, release: next.file, keepLocal: true });
  const now = call("inspect", { workspace: f.workspace }),
    sdk = path.join(now.generation, "studioSdk");
  assert.equal(fs.readFileSync(path.join(sdk, "lib/to-file"), "utf8"), "new leaf");
  assert.equal(fs.statSync(path.join(sdk, "lib/to-file")).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(sdk, "lib/to-dir/child"), "utf8"), "new child");
  assert.equal(
    fs.readFileSync(path.join(f.original, "studioSdk/lib/to-file/child"), "utf8"),
    "child-0",
  );
});
