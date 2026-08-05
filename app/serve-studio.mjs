#!/usr/bin/env node
// openrig studio — reference runtime, contract v0.1.
//
// A zero-dependency HTTP server that is the SDK's contract boundary:
//   - serves the shell (shell.html) and the surfaces it hosts
//   - reads + validates the surface manifest (surfaces.json), WARN-FIRST
//   - GET /api/contract        — version, capabilities, manifest validation report
//   - GET /api/factory/state   — the observe envelope (fixture-backed)
//   - GET /api/events          — SSE change-signal stream (signal-only contract)
//   - GET /api/files/*         — read-only, root-pinned file verbs
//
// Fixture-backed by design: this runtime runs anywhere with no external
// process. Data comes from --fixtures <dir> (default ./fixtures beside the
// repo root). Live backings arrive behind the same contract in later
// versions; the API shapes here are the contract, the fixtures are the demo.
//
// Usage: node app/serve-studio.mjs [--port 8890] [--fixtures <dir>]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg("--port", 8890));
const FIXTURES = path.resolve(arg("--fixtures", path.join(ROOT, "fixtures")));
const FILES_ROOT = path.join(FIXTURES, "files-root");
const MANIFEST_PATH = path.join(HERE, "surfaces.json");

// ---- the consumer-surface seam ---------------------------------------------
// A consumer of this SDK (a studio built ON it) needs to register ITS OWN
// surfaces. Before this seam the only registration path pointed INSIDE the
// package — which in a real install is node_modules/@openrig/studio/app/ —
// gitignored, wiped by npm ci, and, worse, CARRIED BY A COPY: duplicating a
// node_modules tree duplicated phantom surface state, so a contaminated
// instance served 200 with a healthy manifest and the WRONG surfaces.
//
// The overlay puts BOTH halves outside the package: the consumer's own
// surfaces.json AND its pages. A configurable manifest path alone would not
// have done it — the rows would move out while the .html stayed in, so the
// contamination class would survive in the half that actually carries state.
// Because consumer surfaces never live in node_modules, copying node_modules
// cannot inject one, and there is nothing to reconcile.
//
// Opt-in and additive. Unset, everything below behaves exactly as before and
// the SDK's own FLOOR needs zero configuration.
const OVERLAY_DIR = (() => {
  const raw = arg("--surfaces", process.env.OPENRIG_STUDIO_SURFACES);
  return raw ? path.resolve(raw) : null;
})();
const OVERLAY_MANIFEST = OVERLAY_DIR ? path.join(OVERLAY_DIR, "surfaces.json") : null;

const CONTRACT_VERSION = "0.1";
// PROCESS IDENTITY — the answer to "the agent edited the page, when may I reload?"
//
// Minted once per process and never derived from a file. A studio COPIES surfaces
// into its runtime directory at boot, so edited source does not reach a browser
// until a restart: watching the file announces a change the page cannot yet see,
// while watching the restart announces exactly the moment new code became
// servable. A consumer latches this on its FIRST observation — successful or not —
// and reloads when it CHANGES, so a surface opened after a restart does not
// immediately reload itself, and a restart that straddles a consumer's startup is
// still seen.
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// FEATURE DETECTION IS THE POINT. contract-meta.md tells a consumer that every
// namespace it uses must appear here and to CHECK BEFORE USE — so a verb this
// runtime answers but does not advertise is worse than a missing verb: the
// consumer does exactly what the contract instructs and concludes the feature is
// absent. focus and drive shipped answering, undeclared, and an independent cold
// build found it by following the documented detection path.
//
// Read and write are separate entries because they are separately true. That is
// what "files.read" has always meant — the files namespace advertises read
// because there are no write verbs — and it lets a runtime offer read-only focus
// honestly rather than claiming a namespace it half-implements.
const CAPABILITIES = ["contract.meta", "observe.factory-state", "stream.events", "files.read",
  "shell.protocol", "focus.read", "focus.write", "drive.read", "drive.write"];

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png",
  ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

const sendJson = (res, code, obj) =>
  { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

// ---- manifest: read + WARN-FIRST validation --------------------------------
// Contract rule: a malformed manifest must LOOK wrong — named errors in the
// startup log and in GET /api/contract's manifest block — but the runtime
// keeps serving the valid rows. It never dies and never silently ignores.
// Kept in step with contract/surface-row.schema.json by a committed test, not by
// care: these are two places computing one property, and the failure when they
// drift is silent in the misleading direction — the schema accepts a field the
// runtime then reports as unknown.
const ROW_OPTIONAL = { glyph: "string", hint: "string", category: "string", samehost: "boolean",
  port: "number", sub: "string", url: "string", hosts: "array", popout: "boolean",
  hideAgents: "boolean", unmountOnBlur: "boolean", railMin: "boolean", project: "string",
  preserve: "array" };

// `label` is "" for a single-manifest runtime, so a zero-config install emits
// byte-identical error strings to before the seam existed — labelling only
// appears once there are two sources to tell apart, and only for consumers who
// opted in. Changing an error contract is listed as BREAKING in contract-meta;
// this keeps the unconfigured path genuinely untouched rather than nearly so.
// `keep` filters rows BEFORE validation. Order matters: contamination must be
// removed before the duplicate-id check, or a stray row PREPENDED to the
// manifest gets the genuine row rejected as its duplicate and then gets dropped
// itself as undeclared — suppressing the authoritative surface entirely. The
// guarantee is that the served set IS the declared set, so a declared surface
// has to survive contamination, not merely fail to be replaced by it.
//
// "Stray" is meant literally and the ordinary cause is a copy: someone
// duplicated a node_modules tree to skip a slow install, or a boot step
// materialised rows into the package. It is an accident, not an act, and the
// rule is the same either way — the runtime serves what the SDK declares.
function validateManifest(raw, label = "", keep = null) {
  const tag = label ? `${label} ` : "";
  const errors = [], warnings = [], valid = [];
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { return { errors: [`${tag}surfaces.json is not valid JSON: ${e.message}`], warnings, valid, doc: null }; }
  if (!Array.isArray(doc.surfaces)) {
    return { errors: [`${tag}surfaces.json must carry a top-level surfaces[] array`], warnings, valid, doc };
  }
  // chatSeats is OPTIONAL, so its absence is silent — but a roster that is
  // DECLARED and unusable must not be. Falling back to the shipped fixture
  // without saying so is the same defect this file exists to prevent, one
  // layer in: a plausible declaration that does nothing. The likeliest real
  // mistake is copying the shape of surfaces.json and writing an object, or
  // rows without a seat field.
  // CONSUMER declarations only. The package ships a fixture roster on purpose
  // as part of its demo, and warning about the SDK's own example on every boot
  // would be noise — and would break the guarantee that an unconfigured
  // runtime produces no warnings at all.
  if (label === "consumer" && doc.chatSeats !== undefined) {
    if (!Array.isArray(doc.chatSeats)) {
      warnings.push(
        `${tag}chatSeats must be an array of {seat, name} rows — got ${doc.chatSeats === null ? "null" : typeof doc.chatSeats}. ` +
        `IGNORED, so the packaged roster is being served instead. A sidebar showing a fixture seat on a real box ` +
        `is the same lie as a fixture rig on the floor.`
      );
    } else {
      const bad = doc.chatSeats.filter((r) => !r || typeof r !== "object" || typeof r.seat !== "string" || !r.seat.trim());
      if (bad.length === doc.chatSeats.length && doc.chatSeats.length) {
        warnings.push(`${tag}chatSeats has ${bad.length} row(s) and NONE carries a usable "seat" — the roster will render empty.`);
      } else if (bad.length) {
        warnings.push(`${tag}chatSeats: ${bad.length} of ${doc.chatSeats.length} row(s) lack a usable "seat" and are ignored.`);
      }
      if (doc.chatSeats.length && doc.chatLocalPort === undefined) {
        warnings.push(`${tag}chatSeats declared without chatLocalPort — seats will be listed but not attachable when served from loopback.`);
      }
    }
  }
  let rows = doc.surfaces;
  if (keep) {
    rows = [];
    doc.surfaces.forEach((row, i) => {
      if (row && typeof row === "object" && !keep(row)) {
        warnings.push(
          `${tag}surfaces[${i}]${row.id ? ` (id: ${row.id})` : ""}: NOT declared by this SDK — ` +
          `IGNORED. An undeclared row in the installed package is contamination (a copied tree, a ` +
          `stale materialisation, or a dependency writing into node_modules); surfaces you own ` +
          `belong in your own directory, registered via --surfaces`
        );
        return;
      }
      rows.push(row);
    });
  }

  const seen = new Set();
  rows.forEach((row, i) => {
    const where = `${tag}surfaces[${i}]${row && row.id ? ` (id: ${row.id})` : ""}`;
    const rowErrors = [];
    if (!row || typeof row !== "object") { errors.push(`${where}: row must be an object`); return; }
    if (typeof row.id !== "string" || !row.id) rowErrors.push(`${where}: id is required (non-empty string)`);
    else if (seen.has(row.id)) rowErrors.push(`${where}: duplicate id — ids must be unique`);
    else seen.add(row.id);
    if (typeof row.name !== "string" || !row.name) rowErrors.push(`${where}: name is required (non-empty string)`);
    // exactly ONE of path | url, and url must be absolute
    const hasPath = "path" in row, hasUrl = "url" in row;
    if (hasPath && hasUrl) rowErrors.push(`${where}: carries BOTH path and url — a row targets exactly one`);
    else if (!hasPath && !hasUrl) rowErrors.push(`${where}: needs exactly one of path (starting with "/") or an absolute url`);
    if (hasPath && !(typeof row.path === "string" && row.path.startsWith("/")))
      rowErrors.push(`${where}: path must be a string starting with "/"`);
    if (hasUrl) {
      // Two checks, both required (the same authority rule the schema's pattern
      // declares, then a real parse):
      // 1. syntactic: https?:// followed immediately by a non-empty authority —
      //    the WHATWG parser NORMALIZES forms like "http:///path" (empty
      //    authority) into "http://path/", silently diverging from the written
      //    string the shell would actually load, so a parse alone cannot catch
      //    them;
      // 2. parse: protocol + non-empty hostname (catches "https://" etc.).
      let parsed = null;
      try { parsed = typeof row.url === "string" ? new URL(row.url) : null; } catch {}
      const syntacticAuthority = typeof row.url === "string" && /^https?:\/\/[^/?#\s]+/.test(row.url);
      if (!syntacticAuthority || !parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname)
        rowErrors.push(`${where}: url must be an absolute http(s) URL with a non-empty host (e.g. https://host/path)`);
    }
    for (const [k, v] of Object.entries(row)) {
      if (["id", "name", "path", "url"].includes(k)) continue; // handled above
      const want = ROW_OPTIONAL[k];
      if (want === undefined) { warnings.push(`${where}: unknown field "${k}" (ignored; fine for forward-compat)`); continue; }
      const got = Array.isArray(v) ? "array" : typeof v;
      if (got !== want) rowErrors.push(`${where}: ${k} must be ${want}, got ${got}`);
    }
    if (rowErrors.length) errors.push(...rowErrors);
    else valid.push(row);
  });
  return { errors, warnings, valid, doc };
}

// ---- manifest sources: the package's own, plus the optional consumer overlay
// Both go through the SAME load/recovery/guard code. Two copies of this logic
// would drift, and the consumer manifest is the one a real deployment actually
// redeploys — so it needs the redeploy-survival guarantees at least as much as the
// package's does, not a simplified version of them.
const signatureOf = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "missing";
  }
};

function makeSource(manifestPath, label) {
  return {
    path: manifestPath,
    label,
    loadedSignature: "unloaded",
    result: { errors: [`${label ? label + " " : ""}surfaces.json not read yet`], warnings: [], valid: [], doc: null },
    state: {
      // "init" until the first load resolves. A process that starts healthy
      // must report recoveries: 0 — booting is not recovering, and a counter
      // that counted it would make "never broke" indistinguishable from
      // "recovered", which is the confusion these fields exist to remove.
      state: "init",          // "init" | "ok" | "invalid" | "unreadable"
      lastLoadedAt: null,
      reloads: 0,
      recoveries: 0,
      lastRecoveryAt: null,
      // Reloads the WATCH did not cause — the file at the served path changed
      // identity and no event fired. Non-zero means the fast path is not
      // holding for this deployment shape and correctness rests on the stat
      // floor. (A directory swap is the usual reason.)
      integrityReloads: 0,
      lastIntegrityReloadAt: null,
    },
  };
}

// ---- what the SDK declares as ITS OWN surfaces ------------------------------
// AUTHORITY ROOT: in runtime source, because
// app/surfaces.json is the artifact contamination mutates. Materialisation
// appended rows to it and copied pages beside it; it never edited this file,
// and a copied node_modules tree carries this source unmodified.
//
// The declaration is the WHOLE ROW, not the id. An id-only authority is
// bypassed by reusing a declared id with a different path or label: a stray
// { id: "floor", name: "STALE FLOOR", path: "/surfaces/stale.html" } would be
// accepted as the SDK's own and serve a page the SDK never shipped under a
// trusted name. Declaring the row means the SDK vouches for exactly what it
// ships — which is also what makes the failure legible, because the mismatch
// names the field that differs rather than merely refusing.
//
// A hardcoded declaration is discipline, so a committed test asserts this set
// deep-equals the rows the package actually ships — change FLOOR's path or name
// without updating here and the suite fails.
//
// NOT covered, deliberately: a dependency shipping a MODIFIED runtime source.
// That is supply-chain compromise, a higher-bar class already accepted by
// installing the SDK at all. See contract/manifest.md.
const SDK_DECLARED_SURFACES = [
  { id: "floor", name: "FLOOR", glyph: "●", path: "/surfaces/floor.html",
    hint: "Live rig-floor seats and queue activity" },
];

// Canonical form so field ORDER cannot smuggle a difference past equality.
const canonical = (row) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));
const DECLARED_CANONICAL = new Set(SDK_DECLARED_SURFACES.map(canonical));
const isSdkDeclared = (row) => DECLARED_CANONICAL.has(canonical(row));

const packageSource = makeSource(MANIFEST_PATH, OVERLAY_MANIFEST ? "package" : "");
const consumerSource = OVERLAY_MANIFEST ? makeSource(OVERLAY_MANIFEST, "consumer") : null;
const sources = () => (consumerSource ? [packageSource, consumerSource] : [packageSource]);

function loadSource(src) {
  const previous = src.state.state;
  src.state.reloads += 1;

  let raw;
  try {
    raw = fs.readFileSync(src.path, "utf8");
  } catch (e) {
    src.result = { errors: [`cannot read ${src.label ? src.label + " " : ""}surfaces.json: ${e.message}`], warnings: [], valid: [], doc: null };
    src.state.state = "unreadable";
    console.error(`manifest ERROR: ${src.result.errors[0]}`);
    // Gone. If it returns at the same path it will be a NEW inode, so re-arm
    // rather than trusting a watch that may be bound to the old one.
    src.loadedSignature = signatureOf(src.path);
    rearmWatches();
    return;
  }

  src.loadedSignature = signatureOf(src.path);
  // Authority is applied HERE, before validation, for the package source only
  // when a consumer overlay makes enforcement active.
  const keep = src === packageSource && consumerSource ? isSdkDeclared : null;
  src.result = validateManifest(raw, src.label, keep);
  src.state.state = src.result.errors.length === 0 ? "ok" : "invalid";
  if (src.state.state === "ok") src.state.lastLoadedAt = new Date().toISOString();

  for (const e of src.result.errors) console.error(`manifest ERROR: ${e}`);
  for (const w of src.result.warnings) console.error(`manifest warn:  ${w}`);

  // A recovery is a TRANSITION into health, not merely being healthy.
  if (src.state.state === "ok" && previous !== "ok" && previous !== "init") {
    src.state.recoveries += 1;
    src.state.lastRecoveryAt = src.state.lastLoadedAt;
    console.log(
      `manifest RECOVERED: ${src.path} — ${src.result.valid.length} ${src.label || "package"} surface(s) ` +
      `after "${previous}" (recovery #${src.state.recoveries}, no restart)`
    );
  }
}

function loadManifest() {
  for (const src of sources()) loadSource(src);
}

// ---- the merged rail --------------------------------------------------------
// Package rows first, then the consumer's. A consumer MAY deliberately replace
// a stock surface by reusing its id — but never silently: shadowing is named in
// warnings, because an operator who sees their own surface appear would
// otherwise have no way to learn that something was displaced.
function mergedSurfaces() {
  const warnings = [];
  const errors = [];
  const owner = new Map();   // row.path -> "package" | "consumer"

  // ONE RULE: serve exactly what is authoritatively DECLARED — the SDK's own
  // surfaces plus the consumer's overlay-declared ones — and nothing else.
  // Trust what is declared, not what is present.
  //
  // With an overlay active, a row in the package manifest that the SDK does not
  // declare as its own is contamination: appended by materialisation, carried
  // by a copied tree, or injected by a dependency. It is IGNORED for serving
  // and WARNED, so a dirty package is visible rather than silently masked —
  // dropping it quietly would hide the contamination instead of surfacing it.
  // Undeclared package rows were already removed at validation time, before the
  // duplicate-id check, so everything surviving here is authoritative.
  const enforcing = Boolean(consumerSource);
  const packageRows = packageSource.result.valid;

  const byId = new Map(packageRows.map((row) => [row.id, row]));
  for (const row of packageRows) {
    if (typeof row.path === "string") owner.set(row.path, "package");
  }
  if (consumerSource) {
    // A declared package row OWNS its path. A consumer row may take that path
    // ONLY by shadowing at the ID level — the documented, warned way to replace
    // a stock surface. Letting a different-id row claim it would take over the
    // package's page silently: both rail entries would load consumer bytes with
    // no shadow warning, and replacement would become a filename act rather
    // than an id act, which is exactly what the stable rule forbids.
    const packagePaths = new Map(packageRows.map((r) => [r.path, r.id]).filter(([p]) => typeof p === "string"));
    for (const row of consumerSource.result.valid) {
      const collidesWith = typeof row.path === "string" ? packagePaths.get(row.path) : undefined;
      if (collidesWith !== undefined && collidesWith !== row.id) {
        errors.push(
          `consumer surfaces.json (id: ${row.id}): path "${row.path}" is already owned by the ` +
          `package surface "${collidesWith}" — EXCLUDED. Replace a package surface by reusing its ` +
          `id (which warns), not by reusing its path`
        );
        continue;
      }
      if (byId.has(row.id)) {
        warnings.push(
          `consumer surfaces.json: id "${row.id}" SHADOWS the package surface of the same id — ` +
          `the consumer row is served`
        );
      }
      byId.set(row.id, row);   // Map keeps the original position on overwrite
      if (typeof row.path === "string") owner.set(row.path, "consumer");
    }
  }

  // A path only belongs to a source if a row that SURVIVED merge still claims it.
  const live = new Set([...byId.values()].map((r) => r.path).filter(Boolean));
  for (const key of [...owner.keys()]) if (!live.has(key)) owner.delete(key);

  // Undeclared FILES sitting in the package are warned too — a phantom page can
  // be copied in without a row, and silence would hide it.
  if (enforcing) {
    const served = new Set([...owner.entries()].filter(([, src]) => src === "package").map(([p]) => path.basename(p)));
    let present = [];
    try { present = fs.readdirSync(path.join(HERE, "surfaces")).filter((f) => !f.startsWith(".")); } catch { /* none */ }
    for (const file of present) {
      if (!served.has(file)) {
        warnings.push(
          `package app/surfaces/${file}: present but NOT declared by this SDK — not served. ` +
          `An undeclared file in the installed package is contamination`
        );
      }
    }
  }

  return { rows: [...byId.values()], warnings, errors, owner };
}

// Which roster is actually SERVED, and from where.
//
// Surfaces MERGE (package rows plus consumer rows, id-shadow warned). The seat
// roster REPLACES: a declared consumer roster wins entire. That asymmetry is
// deliberate — merging would append the SDK's fixture seat to every real box's
// roster, reinstating exactly the fiction the seam exists to remove. It is
// documented in contract/manifest.md because the behaviours differ and the
// word "merge" invites the wrong assumption.
//
// One function so the served document and the contract report cannot disagree
// about whose roster is live. Two places computing it independently is how a
// report ends up describing something the runtime is not doing.
function servedSeats() {
  const overlay = consumerSource?.result?.doc;
  const pkg = packageSource.result.doc;
  const fromConsumer = overlay && typeof overlay === "object" && Array.isArray(overlay.chatSeats);
  const doc = fromConsumer ? overlay : (pkg && typeof pkg === "object" ? pkg : {});
  const rows = Array.isArray(doc.chatSeats) ? doc.chatSeats : [];
  return {
    rows,
    source: fromConsumer ? "consumer" : "package",
    chatLocalPort: doc.chatLocalPort,
  };
}

// The aggregate the rail actually is: every source's errors and warnings, and
// the merged row count. Per-source detail hangs off it so a reader can tell
// WHICH manifest is unhealthy rather than only that something is.
function manifestReport() {
  const merged = mergedSurfaces();
  // Merge-level problems (a consumer row colliding with a package-owned path)
  // are errors in their own right, not just per-source validation failures.
  const errors = [...sources().flatMap((s) => s.result.errors), ...merged.errors];
  const warnings = [...sources().flatMap((s) => s.result.warnings), ...merged.warnings];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    surfaces: merged.rows.length,
    // A consumer that declares a roster must be able to ASK whether it was
    // read, rather than infer it from what the sidebar happens to render.
    // `source` is the whole point: "package" while an overlay is configured
    // means the consumer's declaration did not take, which is the failure this
    // field exists to make visible. `attachable` distinguishes listed-but-not-
    // reachable from an empty rig — different causes a viewer can act on
    // differently.
    seats: (() => {
      const s = servedSeats();
      return { count: s.rows.length, source: s.source, attachable: s.chatLocalPort !== undefined };
    })(),
    // Top-level state fields describe the PACKAGE source, unchanged in meaning
    // from before the seam existed. The consumer's are under `consumer`.
    ...packageSource.state,
    consumer: consumerSource
      ? { dir: OVERLAY_DIR, surfaces: consumerSource.result.valid.length, ...consumerSource.state }
      : null,
  };
}

// NOTE: the startup load is deliberately NOT called here. loadManifest's
// read-failure path reaches for the watcher machinery declared further down, so
// calling it at this point put a `let` binding in its temporal dead zone and
// the process died at boot whenever surfaces.json happened to be missing —
// precisely the moment a redeploy is mid-flight. Hoisting the one binding that
// tripped first only moved the tripwire. See the init block at the bottom of
// this file: nothing runs until every declaration exists.

// ---- observe: the factory/state envelope (fixture-backed) ------------------
// The envelope is runtime-designed and declared field-by-field in
// contract/runtime-api.md. generatedAt is stamped fresh on every read so a
// consumer can tell a live response from a cached one.
function factoryState() {
  const f = path.join(FIXTURES, "factory-state.json");
  let d;
  try { d = JSON.parse(fs.readFileSync(f, "utf8")); }
  catch (e) { return { ok: false, degraded: `fixture unreadable: ${e.message}`, rig: null, seats: [], queue: [] }; }
  // A consumer generating this from a REAL source can say why it is empty, and
  // the reasons are not interchangeable: no rig on this box is a different
  // fact from a rig with nothing running, and a surface can offer to start one
  // only if it is told which. Carried through when present so an honest
  // absence does not arrive looking like an idle rig. Omitted for the shipped
  // fixture, which is neither — it is a demo, and should not claim to be
  // attached to anything.
  const attachment = typeof d.attached === "boolean"
    ? { attached: d.attached, reason: d.reason ?? null, detail: d.detail ?? null }
    : {};
  return { ok: true, rig: d.rig || "fixture", generatedAt: new Date().toISOString(), ...attachment,
    seats: Array.isArray(d.seats) ? d.seats : [], queue: Array.isArray(d.queue) ? d.queue : [] };
}

// ---- stream: SSE change-signal (signal-only contract) ----------------------
// Contract: a message means "state changed — re-fetch what you care about via
// the observe verbs." Payload contents are unspecified in v0 and must not be
// parsed. A `degraded` event means the signal source is unhealthy; fall back
// to polling. Heartbeat comments keep intermediaries from closing the stream.
const sseClients = new Set();
function sseBroadcast() {
  for (const res of sseClients) { try { res.write(`data: change\n\n`); } catch {} }
}
// ---- watching: must survive delete -> recreate -----------------------------
// Watching surfaces.json BY PATH binds the watch to that file's inode. Delete
// and recreate it — which is what npm ci, write-tmp+rename deploys, redeploys
// over an existing install, and save-by-rename editors all do — and the new
// file has a NEW inode. The old watch never fires again, so the runtime sits on
// ENOENT forever, serving an empty rail with a 200, until someone restarts it.
//
// Fix: watch the manifest's PARENT DIRECTORY and match by filename. A directory
// inode survives files being replaced inside it, which is what makes this the
// atomic-rename-safe pattern — and it covers in-place edit, delete+recreate and
// tmp+rename with one mechanism.
//
// Belt and braces: rearmWatches() is also called when a load hits ENOENT and
// when a watcher emits an error, so a watch lost some other way — including the
// watched DIRECTORY itself being replaced, which the parent-dir watch does not
// cover — re-establishes instead of dying silently.
const MANIFEST_DIR = path.dirname(MANIFEST_PATH);
const MANIFEST_FILE = path.basename(MANIFEST_PATH);

let watchers = [];
let rearmTimer = null;

function watchForChanges() {
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];

  const targets = [
    // The manifest's PARENT directory — not the manifest file itself.
    { dir: MANIFEST_DIR, recursive: false, onEvent: (name) => {
      if (name === MANIFEST_FILE) loadSource(packageSource);
    } },
    { dir: FIXTURES, recursive: true, onEvent: () => {} },
    { dir: path.join(HERE, "surfaces"), recursive: true, onEvent: (name) => {
      if (name === MANIFEST_FILE) loadSource(packageSource);
    } },
  ];

  // The consumer overlay gets the SAME treatment. Without this, the redeploy-survival defect class returns and the
  // entire defect class returns for consumer surfaces — which are precisely the
  // ones a real deployment redeploys.
  if (consumerSource) {
    targets.push({ dir: OVERLAY_DIR, recursive: true, onEvent: (name) => {
      if (name === MANIFEST_FILE) loadSource(consumerSource);
    } });
  }

  for (const target of targets) {
    try {
      const w = fs.watch(target.dir, { recursive: target.recursive }, (_ev, name) => {
        target.onEvent(name);
        sseBroadcast();
      });
      // A dead watcher must not fail silently — that is the whole defect class.
      w.on("error", () => rearmWatches());
      watchers.push(w);
    } catch { /* a missing watch target is fine; rearm will retry */ }
  }
}

// Debounced so a burst of filesystem events (npm ci, a deploy) re-arms once
// rather than once per event.
function rearmWatches() {
  if (rearmTimer) return;
  rearmTimer = setTimeout(() => {
    rearmTimer = null;
    watchForChanges();
  }, 150);
  rearmTimer.unref?.();
}

// ---- the integrity guard: watches are an optimisation, this is correctness --
//
// Every fs.watch in this file follows an INODE. That is fine until a redeploy
// replaces the thing being watched, and there are two shapes that do:
//
//   npm ci / delete+recreate  — the FILE is replaced. The parent-dir watch
//                               catches it, and the runtime goes ENOENT in
//                               between, so the failure is at least visible.
//   mv new current            — the DIRECTORY is replaced. The watch keeps
//                               following the OLD directory inode, which still
//                               exists under its new name. No event ever fires,
//                               no error is raised, and the runtime serves the
//                               PREVIOUS manifest indefinitely while reporting
//                               state "ok". That is worse than the original ENOENT bug,
//                               slice started on, because it looks healthy.
//
// No arrangement of watches fixes the second case: the watch is not wrong, it
// is watching a directory that is no longer the one at that path. So the
// backstop is not a better watch, it is to stop trusting watches for
// correctness — stat the path we actually serve and compare identity.
//
// One stat per second. The watch still provides the fast path; this bounds the
// worst case for every replacement shape, including ones not thought of here.
// unref'd so it never holds the process open.
function integrityCheck() {
  // Every source, not just the package's. The consumer manifest is the one a
  // real deployment actually redeploys, so it needs this floor at least as much.
  for (const src of sources()) {
    const current = signatureOf(src.path);
    if (current === src.loadedSignature) continue;

    // Say so BEFORE correcting it. A silent correction rebuilds this slice's
    // own pathology one level up: on a clean directory swap the source goes
    // ok -> ok, so no recovery is reported and nothing distinguishes "the watch
    // saw it" from "the watch missed it and the floor caught it".
    const wasHealthy = src.state.state === "ok";
    src.state.integrityReloads += 1;
    src.state.lastIntegrityReloadAt = new Date().toISOString();
    console.log(
      `manifest REPLACED: ${src.path} — the file at this path is not the one ` +
      `loaded (was ${wasHealthy ? "serving normally" : `"${src.state.state}"`}); ` +
      `no watch event fired, caught by the integrity guard ` +
      `(integrity reload #${src.state.integrityReloads})`
    );

    watchForChanges();   // the directory may be a different inode now
    loadSource(src);
  }
}

setInterval(integrityCheck, 1000).unref?.();

setInterval(() => { for (const res of sseClients) { try { res.write(`: heartbeat\n\n`); } catch {} } }, 25000).unref();

// ---- focus: what the user is looking at ------------------------------------
// Held in memory, not on disk, and that is the point rather than a shortcut: the
// measured defect is a write verb with no matching read, which forces every
// consumer onto the record's FILE and so excludes anything not on this machine.
// With no file there is nothing to read but the verb.
//
// The marker carries the boot id because a counter alone cannot promise
// monotonicity across a restart. A restarted runtime therefore issues a marker a
// consumer has never seen, which change-signal.md already defines as changed —
// it fails toward re-reading rather than toward silence.
const FOCUS_FIELDS = ["surface", "selection", "view", "note"];
let focusRecord = {};
let focusSeq = 0;
const focusMarker = () => `${BOOT_ID}.${focusSeq}`;

// A write updates the fields it NAMES and leaves the rest. Whole-record
// replacement is the measured defect: a second verb blanked `view` while writing
// a selection, so pinning something destroyed the view context the focus
// reporter had just written. Both writers were behaving reasonably; the format
// made them collide.
function writeFocus(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "focus write must be a JSON object naming the fields to update" };
  }
  const named = FOCUS_FIELDS.filter((f) => Object.hasOwn(patch, f));
  if (!named.length) {
    return { ok: false, error: `focus write named no known field — one of: ${FOCUS_FIELDS.join(", ")}` };
  }
  for (const f of named) focusRecord[f] = patch[f];   // explicit null clears; that is a statement
  // `at` is server-set: a caller-supplied timestamp cannot be trusted to say when
  // the record last genuinely changed. `by` is caller-declared and this runtime
  // has no identity to override it with — see contract/focus.md.
  focusRecord.at = new Date().toISOString();
  focusRecord.by = typeof patch.by === "string" ? patch.by : null;
  // ANY field change moves the marker, including a view change with an unchanged
  // selection — the case the surveyed implementation misses entirely, because it
  // dedupes on selection alone and a user who changed page has plainly changed
  // what they are looking at.
  focusSeq += 1;
  return { ok: true, marker: focusMarker(), focus: focusRecord };
}

// ---- drive: the agent operating the surface ---------------------------------
// The third primitive. Focus lets an agent see what the user is looking at; this
// lets it change what the user is looking AT, in the page the user already has
// open, rather than by handing back a description of what they should do.
//
// A GENERATION COUNTER, NOT A QUEUE, and this is the load-bearing choice. The
// surface asks "is there anything newer than what I have?" and applies the LATEST
// intent, skipping everything superseded. A queue lets a slow page fall behind and
// then replay instructions that were true minutes ago — animating through states
// nobody asked to see and acting on stale intent while looking perfectly healthy.
// That is the stale-state-with-a-current-label failure, one layer up.
//
// THE OP IS OPAQUE TO THE RUNTIME. It carries INTENT — "show me take 3", "set the
// grade warmer" — and the surface decides how to realise it. The runtime never
// interprets it, so this cannot become a second renderer, and an op is never a
// list of DOM operations: a driver that reached into a page's structure would
// break on any re-layout, and every surface would have to freeze its markup to
// stay drivable. Same decision, for the same reason, as `selection` being typed by
// its surface rather than universally.
let driveOp = null;
let driveSeq = 0;
// HOW MANY TIMES A SURFACE HAS ACTUALLY POLLED. Not a declaration — an
// observation. A runtime that has served ZERO drive reads since boot has nobody
// listening, and it is the only party that can know that.
//
// The defect this exists for shipped and was found on a real box: an agent POSTed
// an op to a hand-built surface that had never adopted the helper, got
// { ok: true, gen: 2 }, and nothing happened. The agent did everything right. A
// runtime is not allowed to report success for a delivery it cannot make.
let driveReads = 0;
const driveMarker = () => `${BOOT_ID}.${driveSeq}`;

function writeDrive(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    return { ok: false, error: "a drive op must be a JSON object carrying intent for the surface" };
  }
  driveSeq += 1;
  driveOp = { ...op, gen: driveSeq, at: new Date().toISOString() };
  // ACCEPTED IS NOT DELIVERED, AND THE CALLER FINDS OUT HERE RATHER THAN LATER.
  // `listening` is false when nothing has ever polled this verb: the op is
  // recorded and no surface will act on it. Reported at the moment of the mistake,
  // in the response the caller is already reading — a doc line only fires once
  // somebody goes looking, which is after they have concluded the platform is
  // broken.
  //
  // STILL NOT CLAIMED, and drive.md says so: listening does not mean HONOURED. A
  // surface can poll, receive, and do nothing. That is the refusal shape, and it
  // stays unspecified until a real application needs one.
  return { ok: true, marker: driveMarker(), op: driveOp, listening: driveReads > 0 };
}

const readBody = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 256 * 1024) req.destroy(); });
  req.on("end", () => resolve(raw));
  req.on("error", () => resolve(""));
});

// ---- files: read-only, root-pinned ----------------------------------------
// Containment is enforced on the REAL path (symlinks fully resolved), not the
// lexical one: a symlink under the root that resolves outside it is refused.
// (A lexical startsWith check follows a symlink straight out of the root.)
const insideRoot = (p) => {
  let real, rootReal;
  try { real = fs.realpathSync(p); rootReal = fs.realpathSync(FILES_ROOT); } catch { return null; }
  return real === rootReal || real.startsWith(rootReal + path.sep) ? real : null;
};
const FILE_KINDS = { image: /\.(png|jpe?g|gif|webp|svg)$/i, video: /\.(mp4|mov|webm)$/i,
  audio: /\.(mp3|wav|m4a|flac)$/i, markdown: /\.(md|markdown)$/i, html: /\.html?$/i,
  text: /\.(txt|json|jsonl|yaml|yml|mjs|js|ts|css|py|sh|toml|csv)$/i };
const fileKind = (name) => Object.entries(FILE_KINDS).find(([, re]) => re.test(name))?.[0] || "other";

function filesTree(dir) {
  const r = dir ? insideRoot(dir) : insideRoot(FILES_ROOT);
  if (!r || !fs.existsSync(r)) return null;
  const dirs = [], files = [];
  for (const name of fs.readdirSync(r).sort()) {
    if (name.startsWith(".")) continue;
    const full = path.join(r, name);
    const real = insideRoot(full); // symlink resolving outside the root: omit
    if (!real) continue;
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) dirs.push({ name, path: full });
    else files.push({ name, path: full, size: st.size, mtime: st.mtimeMs, kind: fileKind(name) });
  }
  return { path: r, dirs, files };
}
function filesSearch(q) {
  const needle = q.toLowerCase(), hits = [];
  const seen = new Set(); // real paths already walked — symlink-cycle safety
  const walk = (dir, depth) => {
    if (hits.length >= 60 || depth > 6) return;
    const realDir = insideRoot(dir);
    if (!realDir || seen.has(realDir)) return;
    seen.add(realDir);
    let names; try { names = fs.readdirSync(realDir); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(realDir, name);
      if (!insideRoot(full)) continue; // escaping symlink: omit
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (name.toLowerCase().includes(needle)) hits.push({ name, path: full, kind: fileKind(name) });
    }
  };
  walk(FILES_ROOT, 0);
  return hits.slice(0, 60);
}

// ---- HTTP ------------------------------------------------------------------
// ---- init: everything above is declarations -------------------------------
// Ordering here is a correctness property, not a style preference. This block
// sits after EVERY module binding — verified by a test, not by reading — so
// startup cannot land in a temporal dead zone no matter what these functions
// grow to touch later.
//
// The weaker arrangement — init partway down, "safe" because the current call
// graph happens not to reach the later bindings — is a temporal dead zone
// waiting for the next edit. Hoisting the one binding that trips only moves the
// tripwire; the position is what makes it safe. Add new startup work HERE, not
// next to the function it calls.
watchForChanges();
loadManifest();

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (u.pathname === "/api/focus") {
      if (req.method === "POST") {
        const raw = await readBody(req);
        let patch;
        try { patch = JSON.parse(raw || "null"); }
        catch (e) { return sendJson(res, 400, { ok: false, error: `focus write is not valid JSON: ${e.message}` }); }
        const result = writeFocus(patch);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      // The read the record never had. `?since=` is the change-signal contract,
      // not a second polling mechanism — see contract/change-signal.md.
      const since = u.searchParams.get("since");
      const marker = focusMarker();
      return sendJson(res, 200, { ok: true, changed: since === null || since !== marker, marker, focus: focusRecord });
    }
    if (u.pathname === "/api/drive") {
      if (req.method === "POST") {
        const raw = await readBody(req);
        let op;
        try { op = JSON.parse(raw || "null"); }
        catch (e) { return sendJson(res, 400, { ok: false, error: `drive op is not valid JSON: ${e.message}` }); }
        const result = writeDrive(op);
        return sendJson(res, result.ok ? 200 : 400, result);
      }
      // The surface polls this. Same `?since=` shape as the change signal and
      // focus, so a surface that already watches one is watching this with the
      // primitive it has rather than a third mechanism of its own.
      driveReads += 1;
      const since = u.searchParams.get("since");
      const marker = driveMarker();
      return sendJson(res, 200, { ok: true, changed: since === null || since !== marker, marker, op: driveOp });
    }
    if (u.pathname === "/api/contract") {
      return sendJson(res, 200, {
        contractVersion: CONTRACT_VERSION,
        runtime: { name: "openrig-studio", flavor: "reference-fixture", boot: BOOT_ID },
        capabilities: CAPABILITIES,
        // Inspectable without posting: an agent can ask whether anything is
        // listening before it drives, rather than learning from a no-op.
        drive: { listening: driveReads > 0, reads: driveReads, ops: driveSeq },
        manifest: manifestReport(),
      });
    }
    if (u.pathname === "/api/factory/state") return sendJson(res, 200, factoryState());
    if (u.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`: connected\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (u.pathname === "/api/files/tree") {
      const t = filesTree(u.searchParams.get("dir"));
      return t ? sendJson(res, 200, { ok: true, ...t })
        : sendJson(res, 400, { ok: false, error: "path outside the files root — files verbs are pinned to the runtime's files-root" });
    }
    if (u.pathname === "/api/files/read") {
      const r = insideRoot(u.searchParams.get("path") || "");
      if (!r || !fs.existsSync(r) || fs.statSync(r).isDirectory())
        return sendJson(res, 404, { ok: false, error: "not found or outside the files root" });
      const kind = fileKind(r);
      if (["markdown", "text", "html"].includes(kind) || (kind === "other" && fs.statSync(r).size < 512 * 1024))
        return sendJson(res, 200, { ok: true, kind: kind === "other" ? "text" : kind,
          content: fs.readFileSync(r, "utf8"), mtime: fs.statSync(r).mtimeMs });
      return sendJson(res, 200, { ok: true, kind, raw: "/api/files/raw?path=" + encodeURIComponent(r), mtime: fs.statSync(r).mtimeMs });
    }
    if (u.pathname === "/api/files/raw") {
      const r = insideRoot(u.searchParams.get("path") || "");
      if (!r || !fs.existsSync(r)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": TYPES[path.extname(r).toLowerCase()] || "application/octet-stream",
        "content-length": fs.statSync(r).size, "cache-control": "no-store" });
      return fs.createReadStream(r).pipe(res);
    }
    if (u.pathname === "/api/files/search") {
      const q = (u.searchParams.get("q") || "").trim();
      return sendJson(res, 200, { ok: true, hits: q.length < 2 ? [] : filesSearch(q) });
    }
    if (u.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { ok: false,
        error: `no such contract route: ${u.pathname} — see GET /api/contract for capabilities and contract/runtime-api.md for the verb set` });
    }
  } catch (e) { return sendJson(res, 500, { ok: false, error: String(e.message || e) }); }

  // the manifest is served as its VALIDATED projection, not the raw file —
  // this is where "invalid rows are excluded from the served rail" is true.
  // The raw file stays on disk for editing; consumers see valid rows only,
  // and the validation report lives at /api/contract.
  if (u.pathname === "/surfaces.json") {
    const doc = packageSource.result.doc && typeof packageSource.result.doc === "object" ? packageSource.result.doc : {};
    // A consumer may contribute the SEAT ROSTER the same way it contributes
    // surfaces. Previously only `surfaces` was overridden, so the package
    // document's own roster reached every install and a consumer's declared
    // seats were read by nothing — no warning, no error, nothing at
    // /api/contract. A plausible declaration that did exactly nothing, which
    // is worse than an unsupported one. The sidebar is the product thesis, so
    // a fixture seat sitting in that panel on a real box is the same lie as a
    // fixture rig on the floor.
    // Resolved by servedSeats() rather than inline, so the document the shell
    // reads and the report at /api/contract can never disagree about whose
    // roster is live. They were computed in two places; a report that describes
    // something the runtime is not doing is the failure mode this codebase
    // keeps paying for, and two copies of one rule is how you get there.
    const live = servedSeats();
    const seats = live.source === "consumer" ? { chatSeats: live.rows } : {};
    const chatPort = live.source === "consumer" && live.chatLocalPort !== undefined
      ? { chatLocalPort: live.chatLocalPort } : {};
    // A box may introduce itself to whoever opens it. Consumer-declared, never
    // shipped: this runtime goes to every box and knows none of their seat
    // names, so a welcome written into a surface would be the bespoke lineage
    // that keeps having to be removed from apps. Carried, not interpreted.
    const consumerDoc = consumerSource?.result?.doc;
    const welcome = consumerDoc && typeof consumerDoc.welcome === "object" && consumerDoc.welcome
      ? { welcome: consumerDoc.welcome } : {};
    return sendJson(res, 200, { ...doc, ...seats, ...chatPort, ...welcome, surfaces: mergedSurfaces().rows });
  }

  // static: shell.html at /, surfaces + assets from the app dir — and, when a
  // consumer overlay is configured, from the consumer's dir FIRST so that a row
  // and its page cannot disagree about which file wins.
  //
  // Containment is enforced on the REAL path for both roots. The overlay is a
  // new file-serving root, and a new root that skips the containment the files
  // verbs already have would be the one place traversal works.
  const rel = (u.pathname === "/" ? "shell.html" : u.pathname).replace(/^\/+/, "");
  // Resolve `sub` under `root`, refusing anything that escapes it. Containment
  // is checked on the REAL path, so a symlink inside the root that points out
  // of it is refused rather than followed.
  const within = (root, sub) => {
    const candidate = path.join(root, path.normalize(sub));
    let real, realRoot;
    try { real = fs.realpathSync(candidate); realRoot = fs.realpathSync(root); } catch { return null; }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    if (fs.statSync(real).isDirectory()) return null;
    return real;
  };

  // Which source owns this URL is decided by the VALIDATED, MERGED rows — not
  // by which directory happens to contain a matching file.
  //
  // Serving the overlay path-first made it a public static root: any file under
  // it answered /surfaces/<name> whether or not a row registered it, so an
  // unregistered consumer file silently outranked a registered package page and
  // an unrelated file in that directory was published. It also let row
  // ownership and page ownership disagree, which is exactly what the id-based,
  // warned shadow semantics exist to prevent.
  const ownedBy = OVERLAY_DIR ? mergedSurfaces().owner.get(u.pathname) : undefined;

  if (ownedBy === "consumer") {
    const file = within(OVERLAY_DIR, rel.slice("surfaces/".length));
    if (!file) {
      // NO cross-owner fallback. A registered consumer row whose page is
      // missing must fail as itself — quietly serving the package's bytes
      // under the consumer's row would be a lie about what is being served.
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(
        `not found: ${u.pathname}\n` +
        `a consumer surface is registered for this path but its page is missing from ${OVERLAY_DIR}\n` +
        `(the package's page is NOT substituted — registration and file must agree)`
      );
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    return res.end(fs.readFileSync(file));
  }

  // With the seam active, an UNDECLARED file under /surfaces/ is unreachable.
  // Rejecting a contaminated ROW while still serving its PAGE would leave the
  // artifact half-published: off the rail but fetchable by anyone who knows the
  // name, which is how a "removed" surface keeps working. It is warned in the
  // manifest report, so it is visible rather than merely absent.
  //
  // Restricted to /surfaces/ deliberately: the shell and package assets resolve
  // as they always have, and with no overlay configured nothing here changes.
  if (OVERLAY_DIR && rel.startsWith("surfaces/") && ownedBy === undefined) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end(
      `not found: ${u.pathname}\n` +
      `no declared surface claims this path — the runtime serves only the SDK's own declared ` +
      `surfaces plus your overlay-declared ones\n` +
      `(if this file is in the installed package, it is undeclared content; see manifest.warnings ` +
      `at /api/contract)`
    );
  }

  // Everything else — the shell, package surfaces, package assets — resolves
  // inside the package exactly as it did before the seam existed.
  const file = within(HERE, rel);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end(`not found: ${u.pathname}\n(surfaces live under /surfaces/, contract meta at /api/contract)`);
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(fs.readFileSync(file));
}).listen(PORT, "127.0.0.1", () => {
  console.log(`openrig studio runtime: http://127.0.0.1:${PORT}/  (contract v${CONTRACT_VERSION})`);
  console.log(`fixtures: ${FIXTURES}`);
  const report = manifestReport();
  if (OVERLAY_DIR) console.log(`consumer surfaces: ${OVERLAY_DIR} (repo-owned; nothing is written into the package)`);
  if (report.errors.length) console.error(`manifest has ${report.errors.length} error(s) — serving ${report.surfaces} valid surface(s); see /api/contract`);
});
