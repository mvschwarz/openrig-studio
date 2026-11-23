import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { sha256 } from "../lib/releases/manifest.mjs";
import {
  planRelease,
  applyRelease,
  inspectWorkspace,
  rollbackWorkspace,
  relinkExtensions,
} from "../lib/releases/workspace.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace: path.join(root, "workspace") };
}
function release(
  root,
  number,
  {
    sampleApi = "v2",
    host = false,
    migrations = [],
    omitInstruction = false,
    runtime = null,
    provider = false,
  } = {},
) {
  const dir = path.join(root, "r" + number);
  fs.mkdirSync(dir);
  const components = {};
  for (const [id, files] of Object.entries({
    studioSdk: {
      "app/shell.html": "shell" + number,
      "package.json": '{"name":"@openrig/studio"}',
      "context/AGENTS.md": "Vendor context " + number,
    },
    studioApps: {
      "apps/files/app.json": '{"id":"files"}',
      "apps/files/app/files.html": "vendor" + number,
    },
  })) {
    if (id === "studioApps" && provider)
      Object.assign(files, {
        "providers/probe/provider.json": '{"package":"probe","run":{"entry":"server.mjs"}}',
        "providers/probe/server.mjs": "export const shipped = true;\n",
      });
    if (id === "studioSdk" && omitInstruction) delete files["context/AGENTS.md"];
    const baseline = Object.entries(files)
      .map(([p, b]) => sha256(Buffer.from(b)) + "  " + p + "\n")
      .join("");
    fs.writeFileSync(path.join(dir, id + ".sha256"), baseline);
    const archive = path.join(dir, id + ".tar.gz");
    const p = spawnSync(
      "python3",
      [
        "-c",
        "import sys,tarfile,json,io\nf=json.load(sys.stdin)\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n for p,s in f.items():\n  b=s.encode();i=tarfile.TarInfo(p);i.size=len(b);i.mode=0o755 if p.endswith('server.mjs') else 0o644;t.addfile(i,io.BytesIO(b))",
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
        ? { interfaces: { studioContract: "v0.1", sampleApi } }
        : {
            requires: {
              studioSdk: ">=0.8.1-pre.1 <0.9.0",
              studioContract: "v0.1",
              sampleApi: "v2",
            },
          }),
    };
  }
  if (runtime) components.studioApps.runtime = runtime;
  if (host)
    components.core = {
      name: "@openrig/cli",
      version: "0.7.1",
      artifact: { file: "external.tgz", sha256: "a".repeat(64), bytes: 1 },
      source: { repo: "core", rev: "b".repeat(40) },
    };
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
    migrations,
  };
  const file = path.join(dir, d.release + ".json");
  fs.writeFileSync(file, JSON.stringify(d));
  return { file, descriptor: d, dir };
}
function custom(workspace) {
  const app = path.join(workspace, "extensions/apps/customer");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, "app.json"),
    '{"id":"customer","name":"Customer","surface":{"path":"/customer","entry":"index.html"}}',
  );
  fs.writeFileSync(path.join(app, "index.html"), "customer-app");
  fs.mkdirSync(path.join(workspace, "project"));
  fs.writeFileSync(path.join(workspace, "project/saved.json"), '{"kept":true}');
  fs.writeFileSync(path.join(workspace, "project/AGENTS.md"), "Customer-owned project context");
}

// A removed replacement gives the shipped app back: remove the folder, apply the installed release.
test("removing an extension that replaced a shipped app restores the shipped one from the installed release's artifact", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0);
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "done");
  const shippedHtml = path.join("studioApps", "apps/files/app/files.html");
  assert.equal(
    fs.readFileSync(path.join(inspectWorkspace(f.workspace).generation, shippedHtml), "utf8"),
    "vendor0",
  );
  // A workspace extension replaces the shipped Files app (needs --keep-local).
  const ext = path.join(f.workspace, "extensions/apps/files");
  fs.mkdirSync(path.join(ext, "app"), { recursive: true });
  fs.writeFileSync(path.join(ext, "app.json"), '{"id":"files"}');
  fs.writeFileSync(path.join(ext, "app/files.html"), "replacement");
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "refused");
  assert.equal(
    applyRelease({ workspace: f.workspace, release: r0.file, keepLocal: true }).outcome,
    "done",
  );
  const g1 = inspectWorkspace(f.workspace).generation;
  assert.ok(
    fs.lstatSync(path.join(g1, "studioApps/apps/files")).isSymbolicLink(),
    "the replacement is linked",
  );
  // The replacement was bad: its folder goes. A relink with no release can't restore, and says so (nothing changes).
  fs.rmSync(ext, { recursive: true, force: true });
  const bare = relinkExtensions({ workspace: f.workspace });
  assert.equal(bare.outcome, "refused");
  assert.deepEqual(bare.restore, ["apps/files"]);
  assert.equal(inspectWorkspace(f.workspace).generation, g1);
  // Applying the installed release restores the shipped bytes and modes; the replacement's generation stays as `previous`.
  const r = applyRelease({ workspace: f.workspace, release: r0.file });
  assert.equal(r.outcome, "done", JSON.stringify(r));
  assert.deepEqual(r.restored, ["apps/files"]);
  const g2 = inspectWorkspace(f.workspace).generation;
  assert.notEqual(g2, g1);
  assert.ok(
    !fs.lstatSync(path.join(g2, "studioApps/apps/files")).isSymbolicLink(),
    "a real directory again",
  );
  assert.equal(fs.readFileSync(path.join(g2, shippedHtml), "utf8"), "vendor0");
  assert.equal(
    fs.readFileSync(path.join(g2, "studioApps/apps/files/app.json"), "utf8"),
    '{"id":"files"}',
  );
  assert.deepEqual(inspectWorkspace(f.workspace).drift, [], "no drift: exactly the shipped bytes");
  assert.equal(rollbackWorkspace(f.workspace).outcome, "done");
  assert.equal(
    inspectWorkspace(f.workspace).generation,
    g1,
    "rollback returns to the replaced generation exactly",
  );
});

test("a relink that only removes a workspace-only extension needs no release (nothing shipped to restore)", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0);
  custom(f.workspace);
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "done");
  fs.rmSync(path.join(f.workspace, "extensions/apps/customer"), { recursive: true, force: true });
  const r = relinkExtensions({ workspace: f.workspace });
  assert.equal(r.outcome, "done", JSON.stringify(r));
  assert.equal(r.restored, undefined);
});

test("the restore refuses another release's descriptor", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1);
  applyRelease({ workspace: f.workspace, release: r0.file });
  const ext = path.join(f.workspace, "extensions/apps/files");
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, "app.json"), '{"id":"files"}');
  applyRelease({ workspace: f.workspace, release: r0.file, keepLocal: true });
  fs.rmSync(ext, { recursive: true, force: true });
  const r = relinkExtensions({
    workspace: f.workspace,
    release: { ...r1, sha256: "f".repeat(64) },
  });
  assert.equal(r.outcome, "refused");
  assert.match(r.reason, /INSTALLED release/);
});

const cli = (workspace, ...args) => {
  const r = spawnSync(
    process.execPath,
    [
      new URL("../tools/studio-release.mjs", import.meta.url).pathname,
      ...args,
      "--workspace",
      workspace,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  return { ...r, result: JSON.parse(r.stdout) };
};
function replaced(t) {
  const f = fixture(t),
    r = release(f.root, 0, { provider: true });
  const config = {
    apps: ["files"],
    unknown: { kept: true },
    roots: { project: path.join(f.workspace, "project") },
  };
  assert.equal(applyRelease({ workspace: f.workspace, release: r.file, config }).outcome, "done");
  for (const name of ["project", "data"]) {
    fs.mkdirSync(path.join(f.workspace, name));
    fs.writeFileSync(path.join(f.workspace, name, "owner.bin"), Buffer.from([0, 1, 2, 255]));
    fs.chmodSync(path.join(f.workspace, name, "owner.bin"), 0o600);
  }
  fs.chmodSync(path.join(f.workspace, "studio.json"), 0o600);
  for (const [p, body] of [
    ["apps/files/app.json", '{"id":"files"}'],
    ["apps/files/app/files.html", "replacement"],
    ["providers/probe/provider.json", '{"package":"probe"}'],
    ["providers/probe/server.mjs", "replacement"],
  ]) {
    const file = path.join(f.workspace, "extensions", p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  assert.equal(cli(f.workspace, "apply", "--release", r.file, "--keep-local").status, 0);
  const generation = inspectWorkspace(f.workspace).generation;
  fs.renameSync(path.join(f.workspace, "extensions"), path.join(f.root, "moved-out"));
  const owner = () =>
    ["studio.json", "project/owner.bin", "data/owner.bin"].map((p) => ({
      path: p,
      body: fs.readFileSync(path.join(f.workspace, p)).toString("hex"),
      mode: fs.statSync(path.join(f.workspace, p)).mode & 0o777,
    }));
  return { ...f, r, generation, owner, before: owner() };
}
test("the actual apply command restores app and provider bytes/modes and rollback preserves owner files", (t) => {
  const f = replaced(t),
    result = cli(f.workspace, "apply", "--release", f.r.file);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.result.restored, ["apps/files", "providers/probe"]);
  const g = inspectWorkspace(f.workspace).generation;
  assert.equal(
    fs.readFileSync(path.join(g, "studioApps/apps/files/app/files.html"), "utf8"),
    "vendor0",
  );
  assert.equal(
    fs.readFileSync(path.join(g, "studioApps/providers/probe/server.mjs"), "utf8"),
    "export const shipped = true;\n",
  );
  assert.equal(
    fs.statSync(path.join(g, "studioApps/providers/probe/server.mjs")).mode & 0o777,
    0o755,
  );
  assert.deepEqual(inspectWorkspace(f.workspace).drift, []);
  assert.deepEqual(f.owner(), f.before);
  assert.equal(cli(f.workspace, "rollback").status, 0);
  assert.equal(inspectWorkspace(f.workspace).generation, f.generation);
  assert.deepEqual(f.owner(), f.before);
});
test("corrupt restore artifact refuses without changing the pointer, receipts or owner data and releases its staging lock", (t) => {
  const f = replaced(t),
    dir = path.join(f.workspace, ".studio-release"),
    receipt = fs.readFileSync(path.join(dir, "installed.json"));
  fs.appendFileSync(path.join(f.r.dir, "studioApps.tar.gz"), "corrupt");
  const result = cli(f.workspace, "apply", "--release", f.r.file);
  assert.notEqual(result.status, 0);
  assert.match(result.result.reason, /Digest\/length mismatch/);
  assert.equal(inspectWorkspace(f.workspace).generation, f.generation);
  assert.deepEqual(fs.readFileSync(path.join(dir, "installed.json")), receipt);
  assert.deepEqual(f.owner(), f.before);
  assert.equal(fs.existsSync(path.join(dir, "operation.lock")), false);
  assert.equal(fs.existsSync(path.join(dir, "pending.json")), false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((p) => p.startsWith(".stage-")),
    [],
  );
});

test("the plan says the shipped ones come back, and extensions.json's last change records what was restored", (t) => {
  const f = replaced(t);
  const plan = planRelease({ workspace: f.workspace, release: f.r.file }).plan;
  assert.match(
    plan.what ?? plan.summary ?? JSON.stringify(plan),
    /The shipped apps\/files, providers\/probe come back: re-extracted from this release's verified artifact/,
  );
  assert.equal(cli(f.workspace, "apply", "--release", f.r.file).status, 0);
  const last = JSON.parse(
    fs.readFileSync(path.join(f.workspace, ".studio-release/extensions.json"), "utf8"),
  ).last;
  assert.deepEqual(last.restored, ["apps/files", "providers/probe"]);
  assert.deepEqual(last.changes.removed, ["apps/files", "providers/probe"]);
});
test("the restore's OWN failure (artifact corrupted after planning) changes nothing and leaves no lock or staging behind", (t) => {
  const f = replaced(t),
    dir = path.join(f.workspace, ".studio-release"),
    receipt = fs.readFileSync(path.join(dir, "installed.json"));
  const target = planRelease({ workspace: f.workspace, release: f.r.file }).target; // planned while the artifact was good
  fs.appendFileSync(path.join(f.r.dir, "studioApps.tar.gz"), "corrupt");
  assert.throws(
    () => relinkExtensions({ workspace: f.workspace, release: target }),
    /Digest\/length mismatch/,
  );
  assert.equal(inspectWorkspace(f.workspace).generation, f.generation);
  assert.deepEqual(fs.readFileSync(path.join(dir, "installed.json")), receipt);
  assert.deepEqual(f.owner(), f.before);
  assert.equal(fs.existsSync(path.join(dir, "operation.lock")), false);
  assert.equal(fs.existsSync(path.join(dir, "pending.json")), false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((p) => p.startsWith(".stage-") || p.startsWith(".shipped-")),
    [],
  );
});
