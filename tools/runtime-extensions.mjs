// Live activation: an app or provider installed, updated or removed while the Studio runs takes effect without a restart.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// The release tools and tools/install-app.mjs write one registration record, .studio-release/extensions.json, after an
// install, update, removal, upgrade or rollback has succeeded (lib/releases/workspace.mjs, recordExtensions). Its marker
// changes on every recorded change. This module watches that record and, for each new marker:
//   1. composes the rail again into a staging folder (the same composer the boot uses);
//   2. starts each new or changed extension provider on a fresh port, through the Studio's own child launcher (so it runs
//      supervised, with the child key and whatever the server hooks add), and waits until it listens;
//   3. swaps everything at once: the composition pointer the runtime and /vendor/ read, the routing tables, the manifest;
//   4. retires the providers it replaced, and reports the outcome for that marker in .runtime/extensions-status.json.
// Anything that fails leaves the running apps exactly as they were, and is reported as "failed" for that marker; the next
// marker is tried afresh. Base providers that no record names are never touched, and a change to the shipped SDK or Apps
// themselves still needs the normal restart (reported, not attempted).
//
// The report records registration activation, never live health: "active" says this marker was composed and its
// providers were listening when it was published.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { composeRail, verbMatches } from "./compose-rail.mjs";
import { isRuntimeOwned } from "../app/verbs.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const STATUS_SCHEMA = "openrig.extensions-activation/v0";

export function readExtensions(studio) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(studio, ".studio-release/extensions.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// The same content identity the registration record uses: path, mode and bytes (a link by its target). A workspace with no
// record yet is baselined from what it runs now, so its first install doesn't reload every app it already has.
export function snapshotExtensions(appsRoot, rail) {
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const hash = (root) => {
    const lines = [];
    const walk = (dir, rel = "") => {
      for (const e of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const f = path.join(dir, e.name),
          p = rel ? rel + "/" + e.name : e.name;
        if (e.isSymbolicLink()) lines.push(`link ${fs.readlinkSync(f)} ${p}`);
        else if (e.isDirectory()) walk(f, p);
        else if (e.isFile())
          lines.push(
            `${digest(fs.readFileSync(f))} ${(fs.statSync(f).mode & 0o777).toString(8)} ${p}`,
          );
      }
    };
    walk(root);
    return digest(lines.join("\n"));
  };
  const paths = [
    ...rail.rows.map((row) => "apps/" + row.id),
    ...[...rail.providers].map((pkg) => "providers/" + path.basename(pkg)),
  ];
  return {
    managed: false,
    marker: null,
    generation: null,
    mounted: paths.flatMap((p) => {
      const source = path.join(appsRoot, p);
      return fs.existsSync(source)
        ? [{ path: p, source: fs.realpathSync(source), contentSha256: hash(source) }]
        : [];
    }),
  };
}

const listening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(200, () => done(false));
  });
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
// A configured path as the boot reads it: "~" is the home folder, and a relative path is the Studio folder's.
const inStudio = (studio, value) =>
  typeof value === "string"
    ? path.resolve(studio, value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value)
    : value;

// {{port}} · {{port:<pkg>}} · {{root:<kind>}} · {{state}}, resolved exactly as the boot resolves them.
function argsFor(args, pkg, ports, roots, stateDir) {
  const result = [];
  for (const raw of args || []) {
    const root = String(raw).match(/^\{\{root:([a-z]+)\}\}$/);
    if (root) {
      const values = [roots[root[1]]].flat().filter((v) => v != null),
        flag = result.at(-1);
      if (!values.length) {
        result.pop();
        continue;
      }
      result.push(values[0]);
      for (const value of values.slice(1)) result.push(flag, value);
    } else
      result.push(
        String(raw)
          .replace(/\{\{state\}\}/g, stateDir)
          .replace(/\{\{port\}\}/g, String(ports.get(pkg)))
          .replace(/\{\{port:([^}]+)\}\}/g, (_, name) => String(ports.get(name) ?? "")),
      );
  }
  return result;
}
const labelsFor = (pkg, spec) => [
  pkg,
  ...(spec.run?.companions || []).map((c) => `${pkg}:${c.label || c.entry}`),
];

// Each registered app's row carries a revision: its own content and the providers it calls. The shell reloads an open app's
// frame only when that changes (contract/manifest.md).
function extensionRows(rail, state, appsRoot) {
  return rail.rows.map((row) => {
    const item = state?.mounted?.find((m) => m.path === "apps/" + row.id);
    if (!item) return row;
    const app = JSON.parse(
      fs.readFileSync(path.join(appsRoot, "apps", row.id, "app.json"), "utf8"),
    );
    const dependencies = [...rail.providerRuns].filter(
      ([pkg, spec]) =>
        pkg === app.provider?.package ||
        Object.keys(app.calls || {}).some((verb) =>
          (spec.verbs || []).some((declared) => verbMatches(declared, verb)),
        ),
    );
    const revisions = dependencies
      .map(
        ([pkg]) =>
          state.mounted.find((m) => m.path === "providers/" + path.basename(pkg))?.contentSha256,
      )
      .filter(Boolean);
    return {
      ...row,
      revision: createHash("sha256")
        .update(JSON.stringify([item.contentSha256, ...revisions]))
        .digest("hex"),
    };
  });
}

// The runtime and /vendor/ read the composed surfaces and vendor files through one pointer, .runtime/composition, so an
// activation swaps them in a single rename. .runtime/surfaces and .runtime/vendor stay as links to it for tools that read
// the old paths. Compositions a previous boot left behind are cleared first: the boot owns .runtime/ (studio.mjs refuses
// to share it with a running Studio).
export function liveComposition(studio, rail, initial, appsRoot) {
  rail.rows = extensionRows(rail, initial, appsRoot);
  const root = path.join(studio, ".runtime");
  for (const e of fs.readdirSync(root, { withFileTypes: true }))
    if (e.isDirectory() && /^extension-(live|stage)-/.test(e.name))
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
  const version = path.join(root, "extension-live-" + randomUUID());
  fs.mkdirSync(version);
  fs.renameSync(rail.surfacesOut, path.join(version, "surfaces"));
  fs.renameSync(rail.vendorOut, path.join(version, "vendor"));
  const link = path.join(root, "composition"),
    tmp = link + ".next-" + randomUUID();
  fs.symlinkSync(version, tmp, "dir");
  fs.renameSync(tmp, link);
  fs.symlinkSync(path.join(link, "surfaces"), path.join(root, "surfaces"), "dir");
  fs.symlinkSync(path.join(link, "vendor"), path.join(root, "vendor"), "dir");
  rail.surfacesOut = path.join(link, "surfaces");
  rail.vendorOut = path.join(link, "vendor");
  return rail;
}

// Watches the registration record and activates each new marker (see the top of this file). `start(label, entry, args,
// env, meta)` and `retire(label)` are the Studio's own child launcher; `ports`, `serves` and `verbs` are its live routing
// tables, changed here in one synchronous step.
export function refreshExtensions({
  studio,
  rail,
  initial,
  ports,
  serves,
  verbs,
  start,
  retire,
  writeManifest,
  seed,
  log = console.error,
  interval = 1000,
  readinessMs = 5000,
}) {
  const statusPath = path.join(studio, ".runtime/extensions-status.json");
  const installedCode = () => {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(studio, ".studio-release/installed.json"), "utf8"),
      );
      return JSON.stringify(
        ["studioSdk", "studioApps"].map((id) => state.local?.[id]?.artifact?.sha256 ?? null),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const bootCode = installedCode();
  let seen = null,
    previous = initial,
    busy = false,
    closed = false;
  const managed = new Map();
  const custom = (state) =>
    new Map(
      (state?.mounted || [])
        .filter((m) => m.path?.startsWith("providers/"))
        .map((m) => [path.basename(m.path), m.contentSha256]),
    );
  for (const [pkg, spec] of rail.providerRuns)
    if (custom(initial).has(path.basename(pkg)))
      managed.set(pkg, { spec, labels: labelsFor(pkg, spec), port: ports.get(pkg) });
  const status = (state, marker, error, missing = []) => {
    const value = {
      schema: STATUS_SCHEMA,
      marker: marker?.marker ?? null,
      generation: marker?.generation ?? null,
      state,
      at: new Date().toISOString(),
      pid: process.pid,
      ...(error ? { error: error.message } : {}),
      ...(missing.length ? { missing } : {}),
    };
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    const tmp = statusPath + "." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, statusPath);
  };
  async function ready(port) {
    const until = Date.now() + readinessMs;
    while (!closed && Date.now() < until) {
      if (await listening(port)) return;
      await delay(50);
    }
    throw new Error("Extension provider did not start listening");
  }
  async function tick() {
    if (busy || closed) return;
    busy = true;
    let marker,
      staged,
      started = [];
    try {
      marker = readExtensions(studio);
      if (!marker || marker.marker === seen) return;
      if (
        marker.schema !== "openrig.extensions-state/v0" ||
        typeof marker.marker !== "string" ||
        !Array.isArray(marker.mounted)
      )
        throw new Error("Unreadable extension state");
      if (bootCode !== installedCode())
        throw new Error(
          "Shipped SDK or Apps changed; the normal Studio restart is still required. Existing apps were kept.",
        );
      const config = JSON.parse(fs.readFileSync(path.join(studio, "studio.json"), "utf8"));
      const expand = (value) => inStudio(studio, value);
      const appsRoot = expand(config.appsRoot || "apps");
      if (
        marker.generation &&
        fs.realpathSync(path.join(studio, ".studio-release/current")) !== marker.generation
      )
        throw new Error("Extension generation changed before activation");
      // The boot already composed and started this exact marker. It is reported active once its providers listen, the
      // same as for a later install.
      if (marker.marker === initial?.marker) {
        for (const pkg of rail.providers) await ready(ports.get(pkg));
        seen = marker.marker;
        status("active", marker);
        return;
      }
      staged = path.join(studio, ".runtime", "extension-stage-" + randomUUID());
      const next = composeRail({
        appsRoot,
        enabled: config.apps || [],
        doors: config.doors || [],
        runtimeDir: staged,
        studioRoot: studio,
      });
      // The same rule as the boot: an enabled app that can't be composed (no app.json, no surface entry) is reported and
      // left out, and everything else activates; so one stale entry in studio.json never blocks every later install. What
      // the boot refuses to start on, a live activation refuses too.
      if (next.refusals.length) throw new Error(next.refusals.join("; "));
      for (const m of next.missing) log("studio: extensions: MISSING " + m);
      const wanted = custom(marker),
        old = custom(previous),
        nextPorts = new Map(ports),
        changes = new Map(),
        restoredNow = new Set();
      const roots = {
        project: expand(config.sliceRoot),
        media: (config.mediaRoots || []).map(expand),
        canvas: expand(config.canvasRoot),
        footage: expand(config.footageRoot),
        ...Object.fromEntries(
          Object.entries(config.roots || {}).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.map(expand) : expand(v),
          ]),
        ),
      };
      const owners = new Map();
      for (const [pkg, spec] of next.providerRuns) {
        for (const verb of spec.verbs || []) {
          if (isRuntimeOwned(verb) || (owners.has(verb) && owners.get(verb) !== pkg))
            throw new Error(`Provider route conflict: ${verb}`);
          owners.set(verb, pkg);
        }
        const name = path.basename(pkg);
        if (!wanted.has(name)) {
          if (!ports.has(pkg))
            throw new Error(`New provider is not registered as an extension: ${pkg}`);
          // An extension that replaced a shipped provider was removed and the shipped one is back at the same package path:
          // the running process is the extension's, so this name changed. It is retired and the shipped one started.
          if (managed.has(pkg) && old.has(name)) {
            nextPorts.set(pkg, await freePort());
            changes.set(pkg, spec);
            restoredNow.add(pkg);
          }
          continue;
        }
        if (!old.has(name) && ports.has(pkg) && !managed.has(pkg))
          throw new Error(`Extension replaces a running base provider: ${pkg}`);
        if (old.get(name) !== wanted.get(name) || !managed.has(pkg)) {
          nextPorts.set(pkg, await freePort());
          changes.set(pkg, spec);
        }
      }
      const stateDir = path.join(studio, ".runtime/state");
      fs.mkdirSync(stateDir, { recursive: true });
      if (seed)
        await seed(
          {
            ...next,
            providerRuns: new Map([...changes].filter(([pkg]) => !old.has(path.basename(pkg)))),
          },
          roots,
        );
      for (const [pkg, spec] of changes) {
        const dir = path.join(appsRoot, "providers", path.basename(pkg));
        const commands = [
          { ...spec.run, label: pkg },
          ...(spec.run?.companions || []).map((c) => ({
            ...c,
            label: `${pkg}:${c.label || c.entry}`,
          })),
        ];
        const labels = [];
        for (const command of commands) {
          const entry = command.entry && path.join(dir, command.entry);
          if (!entry || !fs.statSync(entry).isFile())
            throw new Error(`Missing provider entry for ${pkg}`);
          const label = command.label + ":" + randomUUID();
          labels.push(label);
          started.push(label);
          const env = Object.fromEntries(
            Object.entries(command.env || {}).map(([k, v]) => [
              k,
              argsFor([v], pkg, nextPorts, roots, stateDir)[0],
            ]),
          );
          const main = command.label === pkg;
          start(
            label,
            entry,
            argsFor(command.args, pkg, nextPorts, roots, stateDir),
            env,
            main ? { kind: "provider", port: nextPorts.get(pkg) } : { kind: "companion" },
          );
        }
        changes.set(pkg, { spec, labels, port: nextPorts.get(pkg) });
      }
      // A provider may name another declared provider's port, so the whole changed set starts before any wait, as at boot.
      for (const [pkg] of changes) await ready(nextPorts.get(pkg));
      // A newer record that arrived while providers were starting wins: this one is not published over it, and the next
      // tick takes the newer marker.
      if (readExtensions(studio)?.marker !== marker.marker)
        throw new Error("Extensions changed during activation");
      const retired = [],
        unchanged = new Map(managed);
      for (const [pkg, item] of managed)
        if (!next.providerRuns.has(pkg) || changes.has(pkg)) retired.push(...item.labels);
      next.rows = extensionRows(next, marker, appsRoot);
      writeManifest(next);
      const link = path.join(studio, ".runtime/composition"),
        tmp = link + ".next-" + randomUUID();
      const former = fs.realpathSync(link);
      fs.symlinkSync(staged, tmp, "dir");
      fs.renameSync(tmp, link);
      // One synchronous swap of the pointer and the routing tables: no request sees half of it.
      for (const [pkg] of managed) ports.delete(pkg);
      managed.clear();
      // A restored shipped provider was started here, so it stays in this module's care (a later replacement retires it).
      for (const [pkg] of next.providerRuns)
        if (wanted.has(path.basename(pkg)) || restoredNow.has(pkg))
          managed.set(pkg, changes.get(pkg) || unchanged.get(pkg));
      for (const [pkg, item] of managed) ports.set(pkg, item.port);
      serves.clear();
      verbs.clear();
      for (const [pkg, spec] of next.providerRuns) {
        for (const prefix of spec.serves || []) serves.set(prefix, ports.get(pkg));
        for (const verb of spec.verbs || []) verbs.set(verb, ports.get(pkg));
      }
      rail.rows = next.rows;
      rail.providerRuns = next.providerRuns;
      rail.providers = next.providers;
      previous = marker;
      seen = marker.marker;
      started = [];
      staged = null;
      for (const label of retired) retire(label);
      status("active", marker, null, next.missing);
      try {
        if (
          path.dirname(former) === fs.realpathSync(path.join(studio, ".runtime")) &&
          /^(extension-stage|extension-live)-/.test(path.basename(former))
        )
          fs.rmSync(former, { recursive: true, force: true });
      } catch (error) {
        log("studio: previous extension composition cleanup — " + error.message);
      }
    } catch (error) {
      for (const label of started) retire(label);
      // A failed marker is tried again only when a new record arrives.
      seen = marker?.marker ?? null;
      log("studio: extensions not activated — " + error.message);
      try {
        status("failed", marker, error);
      } catch (e) {
        log("studio: could not record extension activation — " + e.message);
      }
    } finally {
      if (staged) fs.rmSync(staged, { recursive: true, force: true });
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), interval);
  timer.unref();
  void tick();
  return {
    tick,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
