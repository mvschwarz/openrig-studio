import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { sha256, validateRelease } from "../lib/releases/manifest.mjs";
import {
  planRelease,
  applyRelease,
  activateRelease,
  inspectWorkspace,
  rollbackWorkspace,
} from "../lib/releases/workspace.mjs";
import { composeRail } from "../tools/compose-rail.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace: path.join(root, "workspace") };
}
function release(
  root,
  number,
  { sampleApi = "v2", host = false, migrations = [], omitInstruction = false, runtime = null } = {},
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

test("same creator/upgrader changes vendor bytes and preserves custom app, customer config and data; code rollback keeps them", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1);
  custom(f.workspace);
  const config = {
    apps: ["files", "customer"],
    customer: "caller@fixture",
    unknown: { retained: true },
    roots: { project: path.join(f.workspace, "project") },
  };
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file, config }).outcome, "done");
  const settings = fs.readFileSync(path.join(f.workspace, "studio.json"));
  const before = fs.readdirSync(path.join(f.workspace, ".studio-release"));
  const plan = planRelease({ workspace: f.workspace, release: r1.file }).plan;
  assert.equal(plan.supported, true);
  assert.equal(plan.drift.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.workspace, ".studio-release")), before);
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "done");
  const current = inspectWorkspace(f.workspace);
  assert.equal(current.release, r1.descriptor.release);
  assert.equal(
    fs.readFileSync(path.join(current.generation, "studioApps/apps/files/app/files.html"), "utf8"),
    "vendor1",
  );
  assert.equal(
    fs.readFileSync(path.join(current.generation, "studioApps/apps/customer/index.html"), "utf8"),
    "customer-app",
  );
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, "studio.json")), settings);
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "project/saved.json"), "utf8"),
    '{"kept":true}',
  );
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "project/AGENTS.md"), "utf8"),
    "Customer-owned project context",
  );
  assert.equal(
    fs.readFileSync(path.join(current.generation, "studioSdk/context/AGENTS.md"), "utf8"),
    "Vendor context 1",
  );
  assert.equal(rollbackWorkspace(f.workspace).release, r0.descriptor.release);
  assert.deepEqual(fs.readFileSync(path.join(f.workspace, "studio.json")), settings);
});

test("an interrupted legacy activation stays partial with its checkpoint; explicit activation reconciles once without overwriting config", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    seeded = path.join(f.root, "seed");
  applyRelease({ workspace: seeded, release: r0.file });
  const old = inspectWorkspace(seeded).generation;
  fs.mkdirSync(f.workspace);
  const config = path.join(f.workspace, "studio.json"),
    originalRoot = path.join(old, "studioApps");
  fs.writeFileSync(
    config,
    JSON.stringify({ appsRoot: originalRoot, apps: ["files"], custom: "kept" }),
  );
  const fail = path.join(f.root, "fail"),
    wrapper = path.join(f.root, "python.mjs");
  fs.writeFileSync(fail, "fail");
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env node\nimport fs from 'node:fs';import{spawnSync}from'node:child_process';if(process.argv[3]==='--apps-root'&&fs.existsSync(${JSON.stringify(fail)})){process.stderr.write('inert activation interruption');process.exit(1)}const r=spawnSync('python3',process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);`,
    { mode: 0o755 },
  );
  const prior = process.env.STUDIO_RELEASE_PYTHON;
  process.env.STUDIO_RELEASE_PYTHON = wrapper;
  try {
    assert.throws(
      () =>
        applyRelease({
          workspace: f.workspace,
          release: r0.file,
          baseline: r0.file,
          adoptSdk: path.join(old, "studioSdk"),
          adoptApps: originalRoot,
        }),
      /interruption/,
    );
    assert.equal(inspectWorkspace(f.workspace).installOutcome, "partial");
    assert.ok(inspectWorkspace(f.workspace).pending);
    assert.equal(JSON.parse(fs.readFileSync(config)).appsRoot, originalRoot);
    fs.unlinkSync(fail);
    assert.equal(activateRelease({ workspace: f.workspace }).outcome, "done");
    const after = fs.readFileSync(config);
    assert.equal(JSON.parse(after).custom, "kept");
    assert.equal(activateRelease({ workspace: f.workspace }).noop, true);
    assert.deepEqual(fs.readFileSync(config), after);
    assert.equal(rollbackWorkspace(f.workspace).release, null);
    assert.equal(JSON.parse(fs.readFileSync(config)).appsRoot, originalRoot);
  } finally {
    if (prior === undefined) delete process.env.STUDIO_RELEASE_PYTHON;
    else process.env.STUDIO_RELEASE_PYTHON = prior;
  }
});

test("local shipped edit is reported, not overwritten; explicit keep-local retains it and its previous generation", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1);
  applyRelease({ workspace: f.workspace, release: r0.file });
  const old = inspectWorkspace(f.workspace).generation,
    p = "studioApps/apps/files/app/files.html";
  fs.writeFileSync(path.join(old, p), "customer-patch");
  const options = { workspace: f.workspace, release: r1.file };
  assert.equal(planRelease(options).plan.drift.length, 1);
  assert.equal(applyRelease(options).outcome, "refused");
  assert.equal(inspectWorkspace(f.workspace).release, r0.descriptor.release);
  assert.equal(applyRelease({ ...options, keepLocal: true }).outcome, "done");
  assert.equal(
    fs.readFileSync(path.join(inspectWorkspace(f.workspace).generation, p), "utf8"),
    "customer-patch",
  );
  assert.equal(fs.readFileSync(path.join(old, p), "utf8"), "customer-patch");
});

test("unversioned adoption requires exact baseline and roots, preserves their bytes and merges only appsRoot", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1),
    seeded = path.join(f.root, "seed");
  applyRelease({ workspace: seeded, release: r0.file });
  const old = inspectWorkspace(seeded).generation;
  const legacyCustom = path.join(old, "studioApps/apps/legacy-customer");
  fs.mkdirSync(legacyCustom);
  fs.writeFileSync(path.join(legacyCustom, "app.json"), '{"id":"legacy-customer"}');
  fs.writeFileSync(path.join(legacyCustom, "index.html"), "retained original customer app");
  fs.mkdirSync(f.workspace);
  fs.writeFileSync(
    path.join(f.workspace, "studio.json"),
    JSON.stringify({ appsRoot: path.join(old, "studioApps"), apps: ["files"], unknown: "kept" }),
    { mode: 0o600 },
  );
  const opts = { workspace: f.workspace, release: r1.file };
  assert.equal(planRelease(opts).plan.supported, false);
  const final = applyRelease({
    ...opts,
    baseline: r0.file,
    adoptSdk: path.join(old, "studioSdk"),
    adoptApps: path.join(old, "studioApps"),
  });
  assert.equal(final.outcome, "done");
  const config = JSON.parse(fs.readFileSync(path.join(f.workspace, "studio.json")));
  assert.equal(config.unknown, "kept");
  assert.deepEqual(config.apps, ["files"]);
  assert.equal(fs.statSync(path.join(f.workspace, "studio.json")).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(path.join(old, "studioApps/apps/files/app/files.html"), "utf8"),
    "vendor0",
  );
  const current = inspectWorkspace(f.workspace);
  assert.equal(
    fs.realpathSync(path.join(current.generation, "studioApps/apps/legacy-customer")),
    fs.realpathSync(legacyCustom),
  );
  assert.equal(current.drift.length, 0);
});

test("An older optional interface or stock SDK cannot claim v2 just because versions satisfy SemVer; prereleases use default rules", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0);
  assert.equal(validateRelease(r0.descriptor).ok, true);
  r0.descriptor.components.studioSdk.interfaces.sampleApi = "v1";
  assert.equal(validateRelease(r0.descriptor).ok, false);
  delete r0.descriptor.components.studioSdk.interfaces.sampleApi;
  assert.equal(validateRelease(r0.descriptor).ok, false);
  r0.descriptor.components.studioSdk.interfaces.sampleApi = "v2";
  r0.descriptor.components.studioApps.requires.studioSdk = ">=0.8.0 <0.9.0";
  assert.equal(validateRelease(r0.descriptor).ok, false);
});

test("bad artifact bytes cause no workspace write; unknown host operations stay partial even on reentry", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0, { host: true });
  const opts = { workspace: f.workspace, release: r0.file };
  assert.equal(applyRelease(opts).outcome, "partial");
  assert.equal(applyRelease(opts).outcome, "partial");
  const r1 = release(f.root, 1);
  fs.appendFileSync(path.join(r1.dir, "studioApps.tar.gz"), "changed");
  const current = inspectWorkspace(f.workspace).release;
  assert.throws(() => planRelease({ workspace: f.workspace, release: r1.file }), /Digest/);
  assert.equal(inspectWorkspace(f.workspace).release, current);
});

test("host dependencies/migrations cannot switch code on a partial receipt; exact receipt activates the staged target", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0, {
      host: true,
      migrations: [
        {
          id: "fixture-migration",
          component: "core",
          from: "*",
          to: "0.7.1",
          reversible: false,
          recovery: "fixture backup",
        },
      ],
    });
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "partial");
  assert.equal(inspectWorkspace(f.workspace).release, null);
  const d = r0.descriptor,
    receipt = {
      schema: "openrig.host-release-receipt/v0",
      release: d.release,
      descriptorSha256: sha256(fs.readFileSync(r0.file)),
      components: {
        core: {
          version: d.components.core.version,
          sha256: d.components.core.artifact.sha256,
          outcome: "done",
        },
      },
      migrations: [],
    };
  assert.equal(
    activateRelease({ workspace: f.workspace, hostReceipt: receipt }).outcome,
    "partial",
  );
  assert.equal(inspectWorkspace(f.workspace).release, null);
  receipt.migrations.push({ id: "fixture-migration", outcome: "done" });
  assert.equal(activateRelease({ workspace: f.workspace, hostReceipt: receipt }).outcome, "done");
  assert.equal(inspectWorkspace(f.workspace).release, d.release);
  assert.throws(() => rollbackWorkspace(f.workspace), /migration/);
});

test("a vendor edit arriving after staging is retained on the current generation rather than silently overwritten", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1, { host: true });
  applyRelease({ workspace: f.workspace, release: r0.file });
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "partial");
  const old = inspectWorkspace(f.workspace).generation;
  fs.writeFileSync(
    path.join(old, "studioSdk/context/AGENTS.md"),
    "Customer vendor-context patch after staging",
  );
  const c = r1.descriptor.components.core,
    receipt = {
      schema: "openrig.host-release-receipt/v0",
      release: r1.descriptor.release,
      descriptorSha256: sha256(fs.readFileSync(r1.file)),
      components: { core: { outcome: "done", version: c.version, sha256: c.artifact.sha256 } },
      migrations: [],
    };
  const result = activateRelease({ workspace: f.workspace, hostReceipt: receipt });
  assert.equal(result.outcome, "partial");
  assert.match(result.reason, /changed since staging/);
  assert.equal(inspectWorkspace(f.workspace).generation, old);
  assert.equal(rollbackWorkspace(f.workspace).canceledStagingOnly, true);
  assert.equal(
    fs.readFileSync(path.join(old, "studioSdk/context/AGENTS.md"), "utf8"),
    "Customer vendor-context patch after staging",
  );
});

test("a normal scoped provider package needs no invented id, in new extensions or legacy adoption", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    seeded = path.join(f.root, "seed");
  const provider = path.join(f.workspace, "extensions/providers/my-provider");
  fs.mkdirSync(provider, { recursive: true });
  fs.writeFileSync(
    path.join(provider, "provider.json"),
    JSON.stringify({
      package: "@example/my-provider",
      run: { entry: "server.mjs" },
      verbs: ["/api/example"],
    }),
  );
  fs.writeFileSync(path.join(provider, "server.mjs"), "// own provider");
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "done");
  assert.equal(
    fs.realpathSync(
      path.join(inspectWorkspace(f.workspace).generation, "studioApps/providers/my-provider"),
    ),
    fs.realpathSync(provider),
  );
  applyRelease({ workspace: seeded, release: r0.file });
  const old = inspectWorkspace(seeded).generation;
  const legacy = path.join(old, "studioApps/providers/legacy-provider");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(
    path.join(legacy, "provider.json"),
    '{"package":"@example/legacy-provider","run":{"entry":"server.mjs"}}',
  );
  const adopted = path.join(f.root, "adopted");
  fs.mkdirSync(adopted);
  fs.writeFileSync(
    path.join(adopted, "studio.json"),
    JSON.stringify({ appsRoot: path.join(old, "studioApps"), apps: [] }),
  );
  assert.equal(
    applyRelease({
      workspace: adopted,
      release: r0.file,
      baseline: r0.file,
      adoptSdk: path.join(old, "studioSdk"),
      adoptApps: path.join(old, "studioApps"),
    }).outcome,
    "done",
  );
  assert.equal(
    fs.realpathSync(
      path.join(inspectWorkspace(adopted).generation, "studioApps/providers/legacy-provider"),
    ),
    fs.realpathSync(legacy),
  );
});

test("deleted app and instruction stay deleted through startup and an omitted-then-reintroduced vendor path", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1, { omitInstruction: true }),
    r2 = release(f.root, 2);
  applyRelease({ workspace: f.workspace, release: r0.file, config: { apps: ["files"] } });
  const old = inspectWorkspace(f.workspace).generation;
  fs.unlinkSync(path.join(old, "studioSdk/context/AGENTS.md"));
  fs.unlinkSync(path.join(old, "studioApps/apps/files/app.json"));
  for (const r of [r1, r2]) {
    assert.equal(
      applyRelease({ workspace: f.workspace, release: r.file, keepLocal: true }).outcome,
      "done",
    );
    const current = inspectWorkspace(f.workspace),
      appsRoot = path.join(current.generation, "studioApps");
    assert.equal(
      fs.existsSync(path.join(current.generation, "studioSdk/context/AGENTS.md")),
      false,
    );
    assert.equal(fs.existsSync(path.join(appsRoot, "apps/files/app.json")), false);
    const composed = composeRail({
      appsRoot,
      enabled: ["files"],
      runtimeDir: path.join(f.workspace, ".runtime"),
      studioRoot: f.workspace,
    });
    assert.ok(composed.missing.some((s) => s.startsWith("files:")));
    assert.equal(fs.existsSync(path.join(appsRoot, "apps/files/app.json")), false);
    assert.ok(current.drift.some((d) => d.path === "context/AGENTS.md" && d.kind === "missing"));
  }
});

test("a deleted config is never recreated by upgrade, staged activation or SDK startup", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1, { host: true });
  applyRelease({ workspace: f.workspace, release: r0.file, config: { apps: [], retained: true } });
  const config = path.join(f.workspace, "studio.json"),
    bytes = fs.readFileSync(config),
    before = inspectWorkspace(f.workspace).generation;
  fs.unlinkSync(config);
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "refused");
  assert.equal(fs.existsSync(config), false);
  assert.equal(inspectWorkspace(f.workspace).generation, before);
  fs.writeFileSync(config, bytes);
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "partial");
  fs.unlinkSync(config);
  const c = r1.descriptor.components.core,
    receipt = {
      schema: "openrig.host-release-receipt/v0",
      release: r1.descriptor.release,
      descriptorSha256: sha256(fs.readFileSync(r1.file)),
      components: { core: { outcome: "done", version: c.version, sha256: c.artifact.sha256 } },
      migrations: [],
    };
  const activated = activateRelease({ workspace: f.workspace, hostReceipt: receipt });
  assert.equal(activated.outcome, "partial");
  assert.match(activated.reason, /studio.json.*removed/);
  assert.equal(inspectWorkspace(f.workspace).generation, before);
  const boot = spawnSync(
    process.execPath,
    [new URL("../tools/studio.mjs", import.meta.url).pathname],
    { env: { ...process.env, OPENRIG_STUDIO_DIR: f.workspace }, encoding: "utf8" },
  );
  assert.equal(boot.status, 1);
  assert.match(boot.stderr, /no studio.json/);
  assert.equal(fs.existsSync(config), false);
});

test("installed source does not assert effective runtime or instruction loading", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0);
  const applied = applyRelease({ workspace: f.workspace, release: r0.file });
  for (const observed of [
    applied,
    inspectWorkspace(f.workspace),
    activateRelease({ workspace: f.workspace }),
  ]) {
    assert.equal(observed.effective.state, "unknown");
    assert.equal(observed.effective.activeRevisions, null);
    assert.equal(observed.effective.installedRevisions.studioSdk, "a".repeat(40));
    assert.match(observed.effective.next, /restart.*handover/);
  }
});

test("known SDK and Apps downgrades refuse before writes on managed upgrade and legacy adoption", (t) => {
  const f = fixture(t),
    old = release(f.root, 0),
    target = release(f.root, 1);
  old.descriptor.components.studioSdk.version = "0.9.0";
  old.descriptor.components.studioApps.version = "0.2.0";
  old.descriptor.components.studioApps.requires.studioSdk = ">=0.9.0 <1.0.0";
  fs.writeFileSync(old.file, JSON.stringify(old.descriptor));
  applyRelease({ workspace: f.workspace, release: old.file });
  const current = inspectWorkspace(f.workspace).generation;
  const legacy = path.join(f.root, "legacy");
  fs.mkdirSync(legacy);
  fs.writeFileSync(
    path.join(legacy, "studio.json"),
    JSON.stringify({ appsRoot: path.join(current, "studioApps"), apps: [] }),
  );
  for (const options of [
    { workspace: f.workspace },
    {
      workspace: legacy,
      baseline: old.file,
      adoptSdk: path.join(current, "studioSdk"),
      adoptApps: path.join(current, "studioApps"),
    },
  ]) {
    const result = applyRelease({ ...options, release: target.file });
    assert.equal(result.outcome, "refused");
    for (const id of ["studioSdk", "studioApps"])
      assert.ok(result.errors.some((e) => e.includes("downgrade " + id)));
    assert.equal(
      fs.existsSync(path.join(options.workspace, ".studio-release/pending.json")),
      false,
    );
  }
  assert.equal(inspectWorkspace(f.workspace).generation, current);
  assert.equal(fs.existsSync(path.join(legacy, ".studio-release")), false);
});

test("a component's runtime need is a valid range, and an invalid one is refused at validation", (t) => {
  const f = fixture(t),
    ok = release(f.root, 0, { runtime: { openrigCore: ">=0.7.8" } });
  assert.equal(validateRelease(ok.descriptor).ok, true);
  const bad = structuredClone(ok.descriptor);
  bad.components.studioApps.runtime = { openrigCore: "soon" };
  const v = validateRelease(bad);
  assert.equal(v.ok, false);
  assert.match(v.errors.join("; "), /studioApps\.runtime\.openrigCore/);
  const wrongShape = structuredClone(ok.descriptor);
  wrongShape.components.studioApps.runtime = ">=0.7.8";
  assert.equal(validateRelease(wrongShape).ok, false);
});

test("plan reports a runtime need against the observed runtime, never changes supported, and apply ignores it", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1, { runtime: { openrigCore: ">=0.7.8" } });
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "done");
  const old = planRelease({ workspace: f.workspace, release: r1.file, coreVersion: "0.7.1" }).plan;
  assert.equal(old.supported, true);
  assert.deepEqual(old.runtime, [
    {
      component: "studioApps",
      runtime: "openrigCore",
      needs: ">=0.7.8",
      observed: "0.7.1",
      met: false,
    },
  ]);
  assert.match(old.explanation, /studioApps needs openrigCore >=0\.7\.8; this host runs 0\.7\.1/);
  const current = planRelease({
    workspace: f.workspace,
    release: r1.file,
    coreVersion: "0.7.9",
  }).plan;
  assert.equal(current.runtime[0].met, true);
  assert.doesNotMatch(current.explanation, /needs openrigCore/);
  const unknown = planRelease({ workspace: f.workspace, release: r1.file }).plan;
  assert.equal(unknown.supported, true);
  assert.deepEqual(unknown.runtime, [
    {
      component: "studioApps",
      runtime: "openrigCore",
      needs: ">=0.7.8",
      observed: null,
      met: "unknown",
    },
  ]);
  assert.match(
    unknown.explanation,
    /studioApps needs openrigCore >=0\.7\.8; the host's version wasn't given/,
  );
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "done");
  assert.deepEqual(planRelease({ workspace: f.workspace, release: r0.file }).plan.runtime, []);
});

test("an observed runtime version that isn't a version is reported as unknown rather than guessed", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0, { runtime: { openrigCore: ">=0.7.8" } });
  const plan = planRelease({
    workspace: f.workspace,
    release: r0.file,
    coreVersion: "latest",
  }).plan;
  assert.equal(plan.runtime[0].met, "unknown");
  assert.equal(plan.runtime[0].observed, "latest");
});

test("studio-release plan takes --core-version and reports the runtime need", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1, { runtime: { openrigCore: ">=0.7.8" } });
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "done");
  const cli = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../tools/studio-release.mjs",
  );
  const out = spawnSync(
    process.execPath,
    [cli, "plan", "--workspace", f.workspace, "--release", r1.file, "--core-version", "0.7.2"],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const plan = JSON.parse(out.stdout);
  assert.equal(plan.supported, true);
  assert.equal(plan.runtime[0].met, false);
  assert.equal(plan.runtime[0].observed, "0.7.2");
});

// Rolling back keeps the newer generation's folder (only the pointer moves). Re-applying that release must roll forward, staging a
// fresh generation from today's plan, not trip over the kept folder.
test("apply A, apply B, roll back to A, apply B again: B is current from a fresh generation built on today's plan; a second rollback gives A", (t) => {
  const f = fixture(t),
    r0 = release(f.root, 0),
    r1 = release(f.root, 1);
  assert.equal(applyRelease({ workspace: f.workspace, release: r0.file }).outcome, "done");
  const gA = inspectWorkspace(f.workspace).generation;
  assert.equal(applyRelease({ workspace: f.workspace, release: r1.file }).outcome, "done");
  const gB1 = inspectWorkspace(f.workspace).generation;
  assert.equal(rollbackWorkspace(f.workspace).outcome, "done");
  assert.equal(inspectWorkspace(f.workspace).generation, gA, "rolled back to A");
  assert.ok(fs.existsSync(gB1), "rollback keeps B's folder (only the pointer moves)");
  // Between the rollback and the re-apply, the customer adds an extension: the re-apply must carry it (the kept folder wouldn't).
  custom(f.workspace);
  const again = applyRelease({ workspace: f.workspace, release: r1.file });
  assert.equal(again.outcome, "done", JSON.stringify(again).slice(0, 300));
  const now = inspectWorkspace(f.workspace),
    gB2 = now.generation;
  assert.equal(now.release, r1.descriptor.release, "B is current");
  assert.notEqual(gB2, gB1, "a fresh generation, not the kept folder");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(gB2, "installed.json"), "utf8")).previous,
    gA,
    "previous is A, so a rollback still works",
  );
  assert.ok(
    fs.lstatSync(path.join(gB2, "studioApps/apps/customer")).isSymbolicLink(),
    "today's extension is linked in the new generation",
  );
  assert.ok(
    !fs.existsSync(path.join(gB1, "studioApps/apps/customer")),
    "the kept folder never had it: reusing it would have been stale",
  );
  assert.equal(rollbackWorkspace(f.workspace).outcome, "done");
  assert.equal(inspectWorkspace(f.workspace).generation, gA, "a second rollback gives A");
});
