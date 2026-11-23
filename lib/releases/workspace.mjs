import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import semver from "semver";
import { LOCAL, readRelease, readBaseline, lockedFile, sha256 } from "./manifest.mjs";

const helper = fileURLToPath(new URL("../../tools/release-artifact.py", import.meta.url));
// Archive checks and settings merges run in a Python 3 helper (tarfile, flock).
export function runReleaseHelper(args, options) {
  const python = process.env.STUDIO_RELEASE_PYTHON || "python3";
  const r = spawnSync(python, [helper, ...args], options);
  if (r.error?.code === "ENOENT")
    throw Error(
      `Release operations need Python 3, and "${python}" was not found. Install python3, or set STUDIO_RELEASE_PYTHON to its path.`,
    );
  return r;
}
function workspaceRoot(root) {
  const resolved = path.resolve(root);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(workspaceRoot(parent), path.basename(resolved));
}
const stateDir = (root) => path.join(workspaceRoot(root), ".studio-release");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJSON = (file, value) => {
  const tmp = file + "." + randomUUID();
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
};
function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function takeLock(workspace) {
  const dir = stateDir(workspace),
    lock = path.join(dir, "operation.lock");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    throw Error(
      "Another release operation owns operation.lock. Inspect its checkpoint/process before retrying; never remove a live owner's lock.",
    );
  }
  writeJSON(path.join(lock, "owner.json"), { pid: process.pid, at: new Date().toISOString() });
  return () => fs.rmSync(lock, { recursive: true, force: true });
}
function archive(release, component, destination) {
  const payload = lockedFile(release, component.artifact),
    baseline = readBaseline(release, component);
  const r = runReleaseHelper([payload.file], {
    input: JSON.stringify({ baseline, ...(destination ? { destination } : {}) }),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  if (r.status !== 0) throw Error(r.stderr || "The release archive couldn't be verified.");
  return JSON.parse(r.stdout);
}
function filesAt(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesAt(root, p) : [path.relative(root, p)];
  });
}
function driftAt(root, baseline, ignored = []) {
  const ignore = (p) => ignored.some((i) => p === i || p.startsWith(i + "/"));
  const drift = [];
  for (const p of new Set([...Object.keys(baseline.files), ...filesAt(root)])) {
    if (ignore(p)) continue;
    const file = path.join(root, p),
      old = baseline.files[p];
    let actual = null,
      mode = null,
      kind = "missing";
    if (fs.existsSync(file)) {
      const s = fs.lstatSync(file);
      mode = s.mode & 0o777;
      if (s.isFile()) {
        actual = sha256(fs.readFileSync(file));
        kind = old ? "modified" : "added";
      } else kind = "link-or-special";
    }
    if (actual !== old || (old && mode !== baseline.modes[p])) {
      if (old && actual === old) kind = "mode-only";
      drift.push({
        path: p,
        kind,
        expected: old || null,
        actual,
        expectedMode: old ? baseline.modes[p] : null,
        mode,
      });
    }
  }
  return drift;
}
// EXTENSION LINKS ARE READ FROM THE GENERATION, NOT FROM THE RECEIPT. A receipt
// says what an apply meant to link; the links in the tree are what compose-rail
// will actually find. Comparing the workspace's extensions with the receipt is how
// a same-release apply answered "noop" while a new app sat unlinked.
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
function linkedExtensions(generation) {
  const out = new Map();
  for (const kind of ["apps", "providers"]) {
    const dir = generation && path.join(generation, "studioApps", kind);
    if (!dir || !fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }))
      if (e.isSymbolicLink()) out.set(`${kind}/${e.name}`, real(path.join(dir, e.name)));
  }
  return out;
}
function extensionDelta(generation, wanted) {
  const have = linkedExtensions(generation),
    want = new Map(wanted.map((e) => [e.path, real(e.source)]));
  return {
    added: [...want.keys()].filter((p) => !have.has(p)).sort(),
    removed: [...have.keys()].filter((p) => !want.has(p)).sort(),
    relinked: [...want.keys()].filter((p) => have.has(p) && have.get(p) !== want.get(p)).sort(),
  };
}
const changed = (delta) => !!(delta.added.length || delta.removed.length || delta.relinked.length);
function wantedExtensions(workspace, installed, baselineFiles) {
  const mounts = new Map(
    (installed?.externalExtensions || []).map((e) => [
      e.path,
      {
        ...e,
        replacement:
          !!baselineFiles?.[
            `${e.path}/${e.path.startsWith("apps/") ? "app.json" : "provider.json"}`
          ],
      },
    ]),
  );
  for (const e of extensionMounts(workspace, baselineFiles)) mounts.set(e.path, e);
  return [...mounts.values()];
}
// One hash per extension directory: relative path, mode and bytes of every file.
// It changes when the app's own files change, which a link alone never shows.
function treeSha256(root) {
  const lines = [];
  const walk = (dir, rel) => {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name),
        p = rel ? rel + "/" + e.name : e.name;
      if (e.isSymbolicLink()) lines.push(`link ${fs.readlinkSync(f)} ${p}`);
      else if (e.isDirectory()) walk(f, p);
      else if (e.isFile())
        lines.push(
          `${sha256(fs.readFileSync(f))} ${(fs.statSync(f).mode & 0o777).toString(8)} ${p}`,
        );
    }
  };
  walk(root, "");
  return sha256(Buffer.from(lines.join("\n")));
}
// THE REGISTRATION SIGNAL. One atomic file a runtime can watch: what is linked into
// the current generation now, with a marker that changes on every recorded change
// (adding, updating, removing, upgrading, rolling back). Written only after the
// operation succeeded, so a failure leaves the previous record. It records
// registration, never activation: the runtime reports its own activation outcome.
// A MANAGED studio records the extensions linked into its current generation. An
// UNMANAGED one (no release state) records every app/provider directory under its
// appsRoot, with generation null: the same schema, so one runtime trigger serves both.
export function recordExtensions(workspace, last, { appsRoot } = {}) {
  const root = workspaceRoot(workspace),
    dir = stateDir(root),
    generation = real(path.join(dir, "current")),
    managed = !!generation;
  let entries;
  if (managed) entries = [...linkedExtensions(generation)];
  else {
    if (!appsRoot) {
      // what the studio itself composes from: studio.json's appsRoot, else <studio>/apps
      let configured;
      try {
        configured = json(path.join(root, "studio.json")).appsRoot;
      } catch {}
      appsRoot = path.resolve(
        root,
        String(configured ?? "apps").replace(/^~/, process.env.HOME || "~"),
      );
    }
    entries = [];
    for (const kind of ["apps", "providers"]) {
      const d = path.join(appsRoot, kind);
      if (!fs.existsSync(d)) continue;
      for (const e of fs.readdirSync(d, { withFileTypes: true }))
        if (!e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
          entries.push([`${kind}/${e.name}`, real(path.join(d, e.name))]);
    }
  }
  const mounted = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, source]) => ({
      path: p,
      source,
      contentSha256: source && fs.statSync(source).isDirectory() ? treeSha256(source) : null,
    }));
  const record = {
    schema: "openrig.extensions-state/v0",
    marker: `${Date.now().toString(36)}-${randomUUID()}`,
    at: new Date().toISOString(),
    managed,
    generation,
    mounted,
    last,
  };
  fs.mkdirSync(dir, { recursive: true });
  writeJSON(path.join(dir, "extensions.json"), record);
  return record;
}
// What the runtime last REPORTED about the current registration. Matching marker
// and generation make it the outcome for this registration; anything else is
// "not reported" for it. A matching "active" is still a past report, never a
// statement that the process is alive now.
export function activationReport(root) {
  const read = (f) => {
    try {
      return json(f);
    } catch {
      return null;
    }
  };
  const record = read(path.join(stateDir(root), "extensions.json")),
    status = read(path.join(root, ".runtime", "extensions-status.json"));
  if (!record) return { state: "no-registration-record", liveHealth: "not-checked" };
  const matches =
    !!status &&
    status.schema === "openrig.extensions-activation/v0" &&
    status.marker === record.marker &&
    status.generation === record.generation;
  if (!matches)
    return {
      state: "not-reported",
      marker: record.marker,
      generation: record.generation,
      lastReport: status
        ? {
            marker: status.marker ?? null,
            generation: status.generation ?? null,
            state: status.state ?? null,
            at: status.at ?? null,
          }
        : null,
      liveHealth: "not-checked",
    };
  return {
    state: status.state === "active" || status.state === "failed" ? status.state : "unknown",
    marker: record.marker,
    generation: record.generation,
    at: status.at ?? null,
    pid: status.pid ?? null,
    ...(status.error ? { error: status.error } : {}),
    ...(Array.isArray(status.missing) && status.missing.length ? { missing: status.missing } : {}),
    liveHealth: "not-checked",
  };
}
function effectiveStatus(installed) {
  return {
    state: "unknown",
    installedRevisions: Object.fromEntries(
      Object.entries(installed?.descriptor?.components || {}).map(([id, c]) => [id, c.source.rev]),
    ),
    activeRevisions: null,
    next: "The existing operator must reload/restart the Studio service and observe its status. Reload changed instructions through the normal context or handover path; keep original conversations. File installation does not confirm either effect.",
  };
}
export function inspectWorkspace(workspace) {
  const root = workspaceRoot(workspace),
    dir = stateDir(root),
    installedPath = path.join(dir, "installed.json");
  const pendingFile = path.join(dir, "pending.json"),
    pending = fs.existsSync(pendingFile) ? json(pendingFile) : null;
  // An unversioned Studio still takes live installs (tools/install-app.mjs writes the registration record into its appsRoot), so
  // its runtime's activation report is read here too: without it, an app that went live read as if nothing had been reported.
  if (!fs.existsSync(installedPath))
    return {
      pending,
      outcome: fs.existsSync(path.join(dir, "current")) ? "unknown" : "unversioned",
      workspace: root,
      release: null,
      components: {},
      drift: [],
      extensions: { activation: activationReport(root) },
      effective: effectiveStatus(null),
    };
  const installed = json(installedPath),
    generation = fs.realpathSync(path.join(dir, "current"));
  if (!generation.startsWith(path.join(dir, "releases") + path.sep))
    throw Error("Installed release points outside its code generations.");
  const drift = [];
  for (const [id, c] of Object.entries(installed.local))
    for (const d of driftAt(path.join(generation, id), c.baseline, c.extensionMounts || []))
      drift.push({ component: id, ...d });
  // A release may omit a deleted path and a later one reintroduce it. Keep that
  // deletion in the existing receipt until the customer actually restores it.
  for (const d of installed.retainedDrift || [])
    if (
      d.kind === "missing" &&
      !drift.some((x) => x.component === d.component && x.path === d.path) &&
      !fs.lstatSync(path.join(generation, d.component, d.path), { throwIfNoEntry: false })
    )
      drift.push(d);
  let extensions;
  try {
    extensions = {
      mounted: [...linkedExtensions(generation).keys()].sort(),
      pending: extensionDelta(
        generation,
        wantedExtensions(root, installed, installed.local.studioApps?.baseline.files),
      ),
    };
  } catch (e) {
    extensions = {
      mounted: [...linkedExtensions(generation).keys()].sort(),
      pending: null,
      error: e.message,
    };
  }
  extensions.activation = activationReport(root);
  return {
    pending,
    outcome: "observed",
    installOutcome: installed.outcome,
    runtimeVerified: false,
    effective: effectiveStatus(installed),
    hostOperations: installed.hostOperations,
    workspace: root,
    release: installed.release,
    descriptorSha256: installed.descriptorSha256,
    components: installed.descriptor.components,
    customerOwned: installed.descriptor.customerOwned,
    drift,
    extensions,
    generation,
    installed,
  };
}
function extensionMounts(workspace, appsRoot) {
  const mounts = [];
  for (const kind of ["apps", "providers"]) {
    const root = path.join(workspace, "extensions", kind);
    if (!fs.existsSync(root)) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // .DS_Store and tool staging are never extensions
      if (!e.isDirectory())
        throw Error("An extension must be an app/provider directory: " + e.name);
      const source = path.join(root, e.name),
        manifest = json(path.join(source, kind === "apps" ? "app.json" : "provider.json"));
      if (kind === "apps" && manifest.id !== e.name)
        throw Error("Extension app directory and manifest id differ: " + e.name);
      mounts.push({
        path: `${kind}/${e.name}`,
        source,
        replacement:
          !!appsRoot?.[`${kind}/${e.name}/${kind === "apps" ? "app.json" : "provider.json"}`],
      });
    }
  }
  return mounts;
}
function legacyExtensions(root, baseline) {
  const out = [];
  for (const kind of ["apps", "providers"]) {
    const dir = path.join(root, kind);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const prefix = `${kind}/${e.name}`;
      if (Object.keys(baseline).some((p) => p.startsWith(prefix + "/"))) continue;
      const source = path.join(dir, e.name),
        file = path.join(source, kind === "apps" ? "app.json" : "provider.json");
      if (!fs.existsSync(file)) continue;
      if (kind === "apps" && json(file).id !== e.name)
        throw Error("Legacy customer app's directory and manifest id differ: " + prefix);
      out.push({
        path: prefix,
        source: fs.realpathSync(source),
        origin: "retained-original-customer-root",
      });
    }
  }
  return out;
}
export function planRelease({
  workspace,
  release: releaseFile,
  baseline,
  adoptSdk,
  adoptApps,
  coreVersion,
}) {
  const target = readRelease(releaseFile),
    d = target.descriptor,
    observed = inspectWorkspace(workspace),
    errors = [],
    local = {};
  if (observed.outcome === "unknown")
    errors.push("Installed state is unknown; inspect the current code pointer before retrying.");
  if (observed.release === d.release && observed.descriptorSha256 !== target.sha256)
    errors.push("A release id cannot be reused for different descriptor bytes.");
  if (
    observed.release &&
    observed.release !== d.release &&
    !d.compatibility.upgradeFrom.includes(observed.release)
  )
    errors.push(`No supported upgrade edge from ${observed.release}.`);
  const configFile = path.join(path.resolve(workspace), "studio.json"),
    adopting = !observed.release && fs.existsSync(configFile);
  if (observed.release && !fs.existsSync(configFile))
    errors.push(
      "studio.json was removed or is missing. Keep that deletion; reconcile the required workspace configuration explicitly before upgrading.",
    );
  let prior = observed.installed,
    drift = observed.drift;
  if (adopting) {
    if (!d.compatibility.adoptUnversioned || !baseline || !adoptSdk || !adoptApps)
      errors.push(
        "Unversioned adoption needs adoptUnversioned, --baseline, --adopt-sdk and --adopt-apps; the original roots are kept.",
      );
    else {
      const from = readRelease(baseline),
        roots = { studioSdk: path.resolve(adoptSdk), studioApps: path.resolve(adoptApps) };
      if (
        from.descriptor.release !== d.release &&
        !d.compatibility.upgradeFrom.includes(from.descriptor.release)
      )
        errors.push("The known unversioned baseline is not a supported upgrade source.");
      prior = {
        release: from.descriptor.release,
        descriptor: from.descriptor,
        local: {},
        adoptionRoots: roots,
      };
      drift = [];
      for (const id of LOCAL)
        if (from.descriptor.components[id]) {
          const base = archive(from, from.descriptor.components[id]);
          prior.local[id] = { baseline: base, root: roots[id] };
          drift.push(...driftAt(roots[id], base).map((x) => ({ component: id, ...x })));
        }
    }
  }
  if (prior)
    for (const p of prior.descriptor.customerOwned)
      if (!d.customerOwned.includes(p))
        errors.push(`Target stops protecting customer-owned root ${p}.`);
  for (const id of LOCAL) {
    const before = prior?.descriptor.components[id],
      after = d.components[id];
    if (before && after && semver.lt(after.version, before.version))
      errors.push(
        `Would downgrade ${id} ${before.version} to ${after.version}. Keep the current component or use explicit code rollback.`,
      );
  }
  for (const [id, c] of Object.entries(d.components))
    if (LOCAL.includes(id)) local[id] = { component: c, baseline: archive(target, c) };
  const additions =
    adopting && prior?.local.studioApps
      ? legacyExtensions(prior.adoptionRoots.studioApps, prior.local.studioApps.baseline.files)
      : observed.installed?.externalExtensions || [];
  const mounts = new Map(
    additions.map((e) => [
      e.path,
      {
        ...e,
        replacement:
          !!local.studioApps?.baseline.files[
            `${e.path}/${e.path.startsWith("apps/") ? "app.json" : "provider.json"}`
          ],
      },
    ]),
  );
  for (const e of extensionMounts(path.resolve(workspace), local.studioApps?.baseline.files))
    mounts.set(e.path, e);
  const extensions = [...mounts.values()];
  if (adopting && prior?.local.studioApps) {
    prior.local.studioApps.extensionMounts = additions.map((e) => e.path);
    drift = drift.filter(
      (d) =>
        d.component !== "studioApps" ||
        !additions.some((e) => d.path === e.path || d.path.startsWith(e.path + "/")),
    );
  }
  const changes = Object.entries(d.components)
    .filter(([id, c]) => prior?.descriptor.components[id]?.artifact.sha256 !== c.artifact.sha256)
    .map(([component, c]) => ({
      component,
      from: prior?.descriptor.components[component]?.version || null,
      to: c.version,
      sha256: c.artifact.sha256,
    }));
  // Host receipts are owned by Ops. Reentry or an unchanged host version is not
  // a host receipt and must never promote this local file result to full success.
  const hostOperations = Object.entries(d.components)
    .filter(([id]) => !LOCAL.includes(id))
    .map(([component, c]) => ({
      component,
      version: c.version,
      sha256: c.artifact.sha256,
      action: "reconcile existing Ops receipt or perform maintained host operation",
    }));
  const migrations = d.migrations.filter(
    (m) => !observed.release || m.from === observed.release || m.from === "*",
  );
  const extensionChanges = observed.generation
    ? extensionDelta(observed.generation, extensions)
    : { added: extensions.map((e) => e.path).sort(), removed: [], relinked: [] };
  const sameRelease = observed.release === d.release && !observed.pending,
    relink = sameRelease && changed(extensionChanges);
  const restart = changes.filter((c) => LOCAL.includes(c.component)).map((c) => c.component);
  if (changed(extensionChanges) && !restart.includes("studioApps")) restart.push("studioApps");
  const what = relink
    ? `Same release ${d.release}: workspace extensions changed (${["added", "removed", "relinked"]
        .map((k) => (extensionChanges[k].length ? `${k} ${extensionChanges[k].join(", ")}` : ""))
        .filter(Boolean)
        .join("; ")}). A new code generation keeps every current file and relinks extensions.${((
        r,
      ) =>
        r.length
          ? ` The shipped ${r.join(", ")} come${r.length === 1 ? "s" : ""} back: re-extracted from this release's verified artifact, which needs this installed release's descriptor (apply --release).`
          : "")(shippedRestores(observed.installed, extensionChanges.removed))}`
    : sameRelease
      ? `${d.release} is installed and its extensions are linked; nothing to do.`
      : `${observed.release ? `Upgrade ${observed.release}` : adopting ? "Adopt known unversioned code" : "Create workspace"} → ${d.release}.`;
  // A component's runtime need, against the version the caller observed on this host. Advisory: it never changes supported.
  const runtime = Object.entries(d.components).flatMap(([component, c]) =>
    Object.entries(c.runtime || {}).map(([name, needs]) => {
      const seen = name === "openrigCore" && coreVersion !== undefined ? String(coreVersion) : null;
      return {
        component,
        runtime: name,
        needs,
        observed: seen,
        met: seen !== null && semver.valid(seen) ? semver.satisfies(seen, needs) : "unknown",
      };
    }),
  );
  const runtimeNote = runtime
    .filter((r) => r.met !== true)
    .map(
      (r) =>
        `${r.component} needs ${r.runtime} ${r.needs}; ${r.observed === null ? "the host's version wasn't given (plan --core-version <v>)" : r.met === false ? `this host runs ${r.observed}` : `"${r.observed}" isn't a version`}.`,
    )
    .join(" ");
  const plan = {
    schema: "openrig.release-plan/v0",
    supported: !errors.length,
    errors,
    current: observed.release,
    target: d.release,
    descriptorSha256: target.sha256,
    adopting,
    changes,
    drift,
    extensions,
    extensionChanges,
    relink,
    customerOwned: d.customerOwned,
    migrations,
    hostOperations,
    runtime,
    restart,
    effective: observed.effective,
    recovery:
      "Previous code generations and unversioned roots are retained. Code rollback does not restore configuration or data. Host migrations need their own declared recovery.",
    explanation: `${what} ${drift.length} local vendor changes retained for an explicit decision. Customer configuration/extensions/data stay outside replaced code. Runtime restarts and host operations are not performed by this local file installer.${runtimeNote ? " " + runtimeNote : ""}`,
  };
  return { plan, target, observed, prior, local };
}
function switchPointer(dir, generation) {
  const temp = path.join(dir, ".current-" + randomUUID());
  fs.symlinkSync(generation, temp);
  fs.renameSync(temp, path.join(dir, "current"));
  syncDirectory(dir);
}
function hostDependencies(receipt, supplied) {
  const needed = [];
  if (receipt.hostOperations.length || receipt.migrations.length) {
    if (
      supplied?.schema !== "openrig.host-release-receipt/v0" ||
      supplied.release !== receipt.release ||
      supplied.descriptorSha256 !== receipt.descriptorSha256
    )
      return ["matching workspace-scoped host receipt"];
    for (const op of receipt.hostOperations) {
      const r = supplied.components?.[op.component];
      if (r?.outcome !== "done" || r.version !== op.version || r.sha256 !== op.sha256)
        needed.push(op.component);
    }
    for (const m of receipt.migrations)
      if (!supplied.migrations?.some((r) => r.id === m.id && r.outcome === "done"))
        needed.push("migration:" + m.id);
  }
  return needed;
}
function mergeRoot(configFile, expected, value) {
  const r = runReleaseHelper(["--apps-root", configFile], {
    input: JSON.stringify({ expected, value }),
    encoding: "utf8",
    timeout: 10000,
  });
  if (r.status !== 0)
    throw Error(r.stderr || "appsRoot could not be merged; inspect before retrying.");
}
function finishPending(workspace, supplied) {
  const dir = stateDir(workspace),
    pendingFile = path.join(dir, "pending.json");
  if (!fs.existsSync(pendingFile)) throw Error("No staged release to activate.");
  const pending = json(pendingFile),
    generation = pending.generation;
  if (!generation.startsWith(path.join(dir, "releases") + path.sep))
    throw Error("Staged generation is outside this workspace.");
  const receipt = json(path.join(generation, "installed.json"));
  const configFile = path.join(workspace, "studio.json");
  if (
    (receipt.previous || receipt.adopting || receipt.settingsExisted) &&
    !fs.existsSync(configFile)
  )
    return {
      outcome: "partial",
      staged: true,
      installed: false,
      target: receipt.release,
      checkpoint: pendingFile,
      reason:
        "studio.json was removed after preparation. Its deletion was kept; reconcile the required configuration explicitly before activation.",
      effective: inspectWorkspace(workspace).effective,
    };
  const needed = hostDependencies(receipt, supplied || pending.hostReceipt);
  if (needed.length)
    return {
      outcome: "partial",
      staged: true,
      installed: false,
      target: receipt.release,
      checkpoint: pendingFile,
      hostOperations: receipt.hostOperations,
      migrations: receipt.migrations,
      needed,
      next: "Existing host operator completes/reconciles these operations, then activate with its matching receipt.",
    };
  if (supplied) {
    pending.hostReceipt = supplied;
    writeJSON(pendingFile, pending);
  }
  const pointer = path.join(dir, "current"),
    actual = fs.existsSync(pointer) ? fs.realpathSync(pointer) : null;
  if (actual !== pending.previous && actual !== generation)
    throw Error("Current code changed after staging; inspect before activation.");
  if (actual !== generation) {
    let now;
    if (receipt.adopting)
      now = Object.entries(receipt.adoptionSource || {}).flatMap(([id, c]) =>
        driftAt(c.root, c.baseline, c.extensionMounts || []).map((d) => ({ component: id, ...d })),
      );
    else now = inspectWorkspace(workspace).drift;
    if (JSON.stringify(now) !== JSON.stringify(receipt.retainedDrift))
      return {
        outcome: "partial",
        staged: true,
        installed: false,
        target: receipt.release,
        checkpoint: pendingFile,
        currentDrift: now,
        reason:
          "Vendor files changed since staging. Current code was kept; cancel the staging with rollback, then plan again.",
      };
  }
  const installedPath = path.join(dir, "installed.json");
  if (!fs.existsSync(installedPath) && !fs.lstatSync(installedPath, { throwIfNoEntry: false }))
    fs.symlinkSync("current/installed.json", installedPath);
  // The staged receipt remains partial until the configuration binding finishes.
  // A failure here leaves pending.json and exact roots for an explicit activate retry.
  if (actual !== generation) switchPointer(dir, generation);
  const currentApps = path.join(dir, "current", "studioApps");
  if (receipt.adopting) {
    const currentRoot = json(configFile).appsRoot;
    if (currentRoot !== currentApps) mergeRoot(configFile, receipt.previousAppsRoot, currentApps);
  } else if (!fs.existsSync(configFile))
    writeJSON(configFile, { ...(receipt.initialConfig || { apps: [] }), appsRoot: currentApps });
  receipt.outcome = "done";
  receipt.phase = "files-installed";
  receipt.hostReceipt = pending.hostReceipt || null;
  writeJSON(path.join(generation, "installed.json"), receipt);
  fs.unlinkSync(pendingFile);
  return {
    outcome: "done",
    release: receipt.release,
    installedState: installedPath,
    components: Object.fromEntries(
      Object.entries(receipt.local).map(([k, c]) => [
        k,
        { version: c.version, sha256: c.artifact.sha256 },
      ]),
    ),
    retainedDrift: receipt.retainedDrift,
    restartRequired: receipt.restartRequired,
    runtimeVerified: false,
    effective: effectiveStatus(receipt),
  };
}
// A code switch changes what is linked, so every completed one is recorded.
function recorded(workspace, result, last) {
  if (result.outcome === "done" && !result.noop)
    result.extensions = recordExtensions(workspace, { ...last, release: result.release ?? null });
  return result;
}
export function activateRelease({ workspace, hostReceipt }) {
  workspace = workspaceRoot(workspace);
  const unlock = takeLock(workspace);
  try {
    if (!fs.existsSync(path.join(stateDir(workspace), "pending.json"))) {
      const observed = inspectWorkspace(workspace);
      if (observed.installed?.outcome === "done")
        return {
          outcome: "done",
          noop: true,
          release: observed.release,
          runtimeVerified: false,
          effective: observed.effective,
        };
    }
    return recorded(workspace, finishPending(workspace, hostReceipt), { kind: "release" });
  } finally {
    unlock();
  }
}
// fs.cpSync does not keep file modes (it wrote 0600 for a 0644 file here), and a
// relink must not invent mode drift. Copy each entry, set its mode, keep links as links.
function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name),
      b = path.join(to, e.name),
      mode = fs.lstatSync(a).mode & 0o777;
    if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(a), b);
    // Fill a directory first, then give it its mode: a read-only (0555) directory can't be written into.
    else if (e.isDirectory()) {
      fs.mkdirSync(b);
      copyTree(a, b);
      fs.chmodSync(b, mode);
    } else if (e.isFile()) {
      fs.copyFileSync(a, b);
      fs.chmodSync(b, mode);
    } else
      throw Error(
        "A code generation holds a special file; relink copies only files, directories and links: " +
          a,
      );
  }
}
// `restored` names the shipped apps/providers a removed replacement gave back, so a runtime applying `last` step by step reloads them
// rather than only unloading the removed extension.
const lastChange = (delta, restored = []) => ({
  kind: delta.added.length
    ? "registered"
    : delta.removed.length && !delta.relinked.length
      ? "removed"
      : "relinked",
  changes: delta,
  ...(restored.length ? { restored } : {}),
});
// The removed extensions that had replaced a shipped app/provider: relink restores those from the installed release's artifact.
const shippedRestores = (installed, removed) => {
  const files = installed?.local?.studioApps?.baseline.files || {};
  return removed.filter(
    (p) => !!files[`${p}/${p.startsWith("apps/") ? "app.json" : "provider.json"}`],
  );
};
// RELINK: the installed release stays, only the workspace's own extensions linked into it
// change. Nothing is overwritten, so a new generation COPIES the current one
// (vendor edits, deletions and modes included) and replaces only the links. That is
// why reported vendor drift needs no --keep-local here, while an extension that
// newly shadows a shipped app/provider still does. The current generation is kept
// as `previous`, so rollback returns to it exactly.
//
// A REMOVED REPLACEMENT GIVES THE SHIPPED ONE BACK. When an extension that replaced
// a shipped app/provider is gone from extensions/, its link in the copied generation
// was the only thing at that path, so unlinking it would leave the shipped component
// missing. The shipped bytes are re-extracted from the installed release's own
// verified artifact instead (the same archive() an apply uses), which needs that
// release's descriptor: `apply --release <the installed descriptor>` passes it. So
// recovering from a bad replacement is: move its folder out of extensions/, apply.
export function relinkExtensions({
  workspace,
  keepLocal = false,
  hostReceipt,
  record = true,
  release = null,
} = {}) {
  workspace = workspaceRoot(workspace);
  const observed = inspectWorkspace(workspace);
  if (observed.outcome !== "observed")
    return {
      outcome: "refused",
      reason:
        "This workspace has no installed release; create or adopt one first. Extensions are linked by every create/apply.",
    };
  if (observed.pending)
    return {
      outcome: "refused",
      reason: "A release is staged. Activate it or roll it back before relinking extensions.",
    };
  const installed = observed.installed,
    wanted = wantedExtensions(workspace, installed, installed.local.studioApps?.baseline.files);
  const extensionChanges = extensionDelta(observed.generation, wanted);
  if (!changed(extensionChanges))
    return {
      outcome: installed.outcome,
      noop: true,
      release: observed.release,
      extensionChanges,
      runtimeVerified: false,
      effective: observed.effective,
    };
  const touched = new Set([...extensionChanges.added, ...extensionChanges.relinked]);
  if (!keepLocal && wanted.some((e) => e.replacement && touched.has(e.path)))
    return {
      outcome: "refused",
      extensionChanges,
      reason:
        "An extension replaces a shipped app/provider of the same name. Use --keep-local to keep the workspace's version; the shipped one stays in the current generation.",
    };
  const restore = shippedRestores(installed, extensionChanges.removed);
  if (restore.length && !release)
    return {
      outcome: "refused",
      extensionChanges,
      restore,
      reason:
        "An extension that replaced a shipped app/provider was removed. Apply the installed release (--release <its descriptor.json>) so the shipped one is restored from its artifact.",
    };
  if (
    restore.length &&
    (release.sha256 !== installed.descriptorSha256 || !installed.descriptor.components?.studioApps)
  )
    return {
      outcome: "refused",
      extensionChanges,
      restore,
      reason:
        "Restoring a shipped app/provider needs the INSTALLED release's descriptor, with its Apps component.",
    };
  const dir = stateDir(workspace),
    unlock = takeLock(workspace);
  let staging;
  try {
    const again = inspectWorkspace(workspace);
    if (
      again.generation !== observed.generation ||
      again.pending ||
      JSON.stringify(again.drift) !== JSON.stringify(observed.drift) ||
      JSON.stringify(
        extensionDelta(
          again.generation,
          wantedExtensions(
            workspace,
            again.installed,
            again.installed.local.studioApps?.baseline.files,
          ),
        ),
      ) !== JSON.stringify(extensionChanges)
    )
      throw Error("Workspace changed after planning; read a new plan before applying.");
    const old = json(path.join(observed.generation, "installed.json"));
    const generation = path.join(
      dir,
      "releases",
      `${old.release}-${old.descriptorSha256.slice(0, 12)}-x${randomUUID().slice(0, 8)}`,
    );
    staging = fs.mkdtempSync(path.join(dir, ".stage-"));
    copyTree(observed.generation, staging);
    for (const p of linkedExtensions(staging).keys())
      fs.unlinkSync(path.join(staging, "studioApps", p));
    fs.mkdirSync(path.join(staging, "studioApps"), { recursive: true });
    if (restore.length) {
      // The shipped bytes, verified against the release's own baseline by archive(), then copied in with their modes.
      const holder = fs.mkdtempSync(path.join(dir, ".shipped-")),
        shipped = path.join(holder, "studioApps"); // archive() creates its destination
      try {
        archive(release, installed.descriptor.components.studioApps, shipped);
        for (const p of restore) {
          const from = path.join(shipped, p),
            destination = path.join(staging, "studioApps", p);
          if (!fs.existsSync(from))
            throw Error(
              "The installed release's Apps artifact doesn't hold " + p + "; nothing was changed.",
            );
          fs.rmSync(destination, { recursive: true, force: true });
          fs.mkdirSync(destination, { recursive: true });
          copyTree(from, destination);
          fs.chmodSync(destination, fs.lstatSync(from).mode & 0o777);
        }
      } finally {
        fs.rmSync(holder, { recursive: true, force: true });
      }
    }
    for (const e of wanted) {
      const destination = path.join(staging, "studioApps", e.path);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(e.source, destination);
    }
    const receipt = {
      ...old,
      at: new Date().toISOString(),
      previous: observed.generation,
      relinkedFrom: observed.generation,
      adopting: false,
      adoptionSource: null,
      local: Object.fromEntries(
        Object.entries(old.local).map(([id, c]) => [
          id,
          id === "studioApps" ? { ...c, extensionMounts: wanted.map((e) => e.path) } : c,
        ]),
      ),
      retainedDrift: observed.drift,
      externalExtensions: wanted.filter((e) => e.origin === "retained-original-customer-root"),
      outcome: "partial",
      phase: "staged",
      restartRequired: ["studioApps"],
      runtimeVerified: false,
    };
    writeJSON(path.join(staging, "installed.json"), receipt);
    fs.renameSync(staging, generation);
    staging = null;
    writeJSON(path.join(dir, "pending.json"), {
      schema: "openrig.release-checkpoint/v0",
      target: receipt.release,
      descriptorSha256: receipt.descriptorSha256,
      generation,
      previous: observed.generation,
      hostReceipt: old.hostReceipt || null,
    });
    const result = finishPending(workspace, hostReceipt);
    // A caller with a later step of its own (install-app's --enable) records once, after it.
    if (result.outcome === "done" && record)
      result.extensions = recordExtensions(workspace, lastChange(extensionChanges, restore));
    return {
      ...result,
      extensionChanges,
      relinked: true,
      ...(restore.length ? { restored: restore } : {}),
    };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    unlock();
  }
}
export function applyRelease(options) {
  const workspace = workspaceRoot(options.workspace),
    initial = planRelease({ ...options, workspace });
  if (!initial.plan.supported) return { outcome: "refused", ...initial.plan };
  if (initial.plan.relink) {
    const result = relinkExtensions({
      workspace,
      keepLocal: options.keepLocal,
      hostReceipt: options.hostReceipt,
      release: initial.target,
    });
    return result.outcome === "refused"
      ? { ...initial.plan, ...result }
      : { ...result, plan: initial.plan };
  }
  if (
    (initial.plan.drift.length || initial.plan.extensions.some((e) => e.replacement)) &&
    !options.keepLocal
  )
    return {
      outcome: "refused",
      ...initial.plan,
      reason:
        "Local vendor changes/replacements need --keep-local. They will be retained, not overwritten.",
    };
  if (initial.plan.drift.some((d) => d.kind === "link-or-special"))
    return {
      outcome: "refused",
      ...initial.plan,
      reason:
        "A local vendor link/special file needs manual reconciliation; it is retained in the current/original generation.",
    };
  if (initial.observed.release === initial.plan.target && !initial.observed.pending)
    return {
      outcome: initial.observed.installed.outcome,
      noop: true,
      release: initial.plan.target,
      plan: initial.plan,
      effective: initial.observed.effective,
      runtimeVerified: false,
    };
  const dir = stateDir(workspace),
    unlock = takeLock(workspace);
  let staging;
  try {
    if (fs.existsSync(path.join(dir, "pending.json"))) {
      const pending = json(path.join(dir, "pending.json"));
      if (pending.descriptorSha256 !== initial.target.sha256)
        throw Error(
          "Another target is staged; activate or roll it back before a different upgrade.",
        );
      return recorded(workspace, finishPending(workspace, options.hostReceipt), {
        kind: "release",
      });
    }
    const { plan, target, observed, prior, local } = planRelease({ ...options, workspace });
    if (!plan.supported || JSON.stringify(plan.drift) !== JSON.stringify(initial.plan.drift))
      throw Error("Workspace changed after planning; read a new plan before applying.");
    // A first apply names its generation <release>-<sha12>. A rollback only moves the pointer and keeps the newer generation's
    // folder, so re-applying that release finds the name taken. Its installed.json, extension links and keep-local copies came
    // from THAT apply's plan (extensions added or removed since would come back stale), so it's never reused: a fresh
    // generation is staged from today's plan, named like relinkExtensions' (-g<uuid8>). The existence check below stays as a
    // pure collision guard.
    const named = path.join(
      dir,
      "releases",
      `${target.descriptor.release}-${target.sha256.slice(0, 12)}`,
    );
    const generation = fs.existsSync(named) ? `${named}-g${randomUUID().slice(0, 8)}` : named;
    fs.mkdirSync(path.dirname(generation), { recursive: true });
    if (fs.existsSync(generation))
      throw Error(
        "This code generation already exists; inspect it and the current pointer before retrying.",
      );
    const configFile = path.join(workspace, "studio.json"),
      previousAppsRoot = plan.adopting ? json(configFile).appsRoot : null;
    if (
      plan.adopting &&
      path.resolve(String(previousAppsRoot || "")) !== path.resolve(options.adoptApps)
    )
      throw Error("Configured appsRoot does not match the declared legacy Apps root.");
    staging = fs.mkdtempSync(path.join(dir, ".stage-"));
    for (const [id, c] of Object.entries(local))
      archive(target, c.component, path.join(staging, id));
    fs.mkdirSync(path.join(staging, "studioApps"), { recursive: true }); // Public SDK + customer app needs no shipped Apps component.
    if (options.keepLocal)
      for (const change of plan.drift) {
        const sourceRoot =
            prior?.adoptionRoots?.[change.component] ||
            path.join(observed.generation, change.component),
          destination = path.join(staging, change.component, change.path);
        if (change.kind === "missing") fs.rmSync(destination, { force: true });
        else if (change.kind === "mode-only") {
          // --keep-local selects the local permissions, not the old vendor bytes.
          // A removed/retyped incoming path must not be resurrected for its mode.
          let incoming;
          try {
            incoming = fs.lstatSync(destination);
          } catch (e) {
            // A removed leaf or an ancestor replaced by a file has no incoming
            // file whose permissions can be preserved. Keep the new tree.
            if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
          }
          if (incoming?.isFile()) fs.chmodSync(destination, change.mode);
        } else {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(path.join(sourceRoot, change.path), destination);
          fs.chmodSync(destination, change.mode);
        }
      }
    for (const e of plan.extensions) {
      const destination = path.join(staging, "studioApps", e.path);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(e.source, destination);
    }
    const receipt = {
      schema: "openrig.installed-release/v0",
      release: target.descriptor.release,
      descriptorSha256: target.sha256,
      descriptor: target.descriptor,
      at: new Date().toISOString(),
      previous: observed.generation || null,
      unversionedRoots: prior?.adoptionRoots || null,
      adoptionSource: plan.adopting ? prior.local : null,
      adopting: plan.adopting,
      previousAppsRoot,
      initialConfig: options.config || null,
      settingsExisted: fs.existsSync(configFile),
      local: Object.fromEntries(
        Object.entries(local).map(([id, c]) => [
          id,
          {
            version: c.component.version,
            artifact: c.component.artifact,
            baseline: c.baseline,
            extensionMounts: id === "studioApps" ? plan.extensions.map((e) => e.path) : [],
          },
        ]),
      ),
      retainedDrift: plan.drift,
      externalExtensions: plan.extensions.filter(
        (e) => e.origin === "retained-original-customer-root",
      ),
      outcome: "partial",
      phase: "staged",
      hostOperations: plan.hostOperations,
      migrations: plan.migrations,
      restartRequired: plan.restart,
      runtimeVerified: false,
    };
    writeJSON(path.join(staging, "installed.json"), receipt);
    fs.renameSync(staging, generation);
    staging = null;
    writeJSON(path.join(dir, "pending.json"), {
      schema: "openrig.release-checkpoint/v0",
      target: receipt.release,
      descriptorSha256: target.sha256,
      generation,
      previous: observed.generation || null,
    });
    return recorded(workspace, finishPending(workspace, options.hostReceipt), { kind: "release" });
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    unlock();
  }
}
export function rollbackWorkspace(workspace) {
  workspace = workspaceRoot(workspace);
  const unlock = takeLock(workspace);
  try {
    const dir = stateDir(workspace),
      pendingFile = path.join(dir, "pending.json"),
      pending = fs.existsSync(pendingFile) ? json(pendingFile) : null;
    const state = inspectWorkspace(workspace),
      installed = state.installed;
    if (pending && state.generation !== pending.generation) {
      fs.unlinkSync(pendingFile);
      return {
        outcome: "done",
        release: state.release,
        canceledStagingOnly: true,
        codeAndDataUnchanged: true,
      };
    }
    if (!installed) throw Error("No installed code generation to roll back.");
    if (installed.migrations.length)
      throw Error(
        "A migration is recorded; use its declared host recovery rather than assuming a code rollback restores data.",
      );
    const previous = installed.previous;
    if (previous) {
      if (
        !previous.startsWith(path.join(dir, "releases") + path.sep) ||
        !fs.existsSync(path.join(previous, "installed.json"))
      )
        throw Error("Previous generation is not available.");
      switchPointer(dir, previous);
    } else if (installed.adopting) {
      const configFile = path.join(workspace, "studio.json"),
        currentRoot = json(configFile).appsRoot,
        managed = path.join(dir, "current", "studioApps");
      if (currentRoot !== installed.previousAppsRoot)
        mergeRoot(configFile, managed, installed.previousAppsRoot);
      fs.unlinkSync(path.join(dir, "current"));
      fs.unlinkSync(path.join(dir, "installed.json"));
    } else
      throw Error(
        "No previous managed generation or original unversioned roots; no rollback was attempted.",
      );
    if (pending) fs.unlinkSync(pendingFile);
    const extensions = recordExtensions(workspace, { kind: "rollback" });
    return {
      outcome: "done",
      extensions,
      release: previous ? json(path.join(previous, "installed.json")).release : null,
      codeRollbackOnly: true,
      configurationAndDataRestored: false,
      restartRequired: LOCAL,
      runtimeVerified: false,
      effective: inspectWorkspace(workspace).effective,
    };
  } finally {
    unlock();
  }
}
