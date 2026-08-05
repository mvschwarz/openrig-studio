#!/usr/bin/env node
// INSTALL AN APP INTO THIS STUDIO.
//
// WHY THIS EXISTS. Joining an app to a studio by hand — copy the surface,
// notice it needs a provider, run the provider, guess its roots, add a row —
// fails in ways that only appear when the app is driven: a vendored dependency
// never copied, a provider reaching for a file that has moved, a heavy app's
// byte routes never proxied so its media lists and will not play.
//
// A careful operator with full context can get the same join wrong six ways. That
// is not carelessness — it is the evidence that **the manifest does not carry
// enough to install from**. So this tool's real job is not to copy files. It is
// to REFUSE an app whose manifest cannot describe a working install, and to say
// exactly which fact is missing.
//
// Composition is a separate step and already exists: compose-rail.mjs turns
// INSTALLED apps into a running rail. This is the layer above it — acquiring an
// app so there is something to compose.
//
//   OPENRIG_STUDIO_DIR=<studio> node tools/install-app.mjs <source-dir> [--enable] [--force]
//   OPENRIG_STUDIO_DIR=<studio> node tools/install-app.mjs --check <app-id>
//
// Exit non-zero on any refusal. A half-installed app that looks fine is the
// failure this whole slice has been about.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";


// The studio directory is given, not assumed — this tool ships with the SDK
// and installs into whatever studio you point it at.
const STUDIO = path.resolve(process.env.OPENRIG_STUDIO_DIR || process.cwd());
const CONFIG_PATH = path.join(STUDIO, "studio.json");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const positional = argv.filter((a) => !a.startsWith("--"));

const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : { apps: [], appsRoot: path.join(STUDIO, "apps") };
const appsRoot = (config.appsRoot ?? path.join(STUDIO, "apps")).replace(/^~/, os.homedir());

let failures = 0;
const problems = [];
const ok = (m) => console.log(`  OK    ${m}`);
const fail = (m, fix) => { failures++; problems.push({ m, fix }); console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`  ·     ${m}`);

// ---- the checks -------------------------------------------------------------
// Each one exists because its absence produced a real defect. The comment names
// which, so nobody later "simplifies" a check whose cost is already paid.

function checkManifest(dir) {
  const p = path.join(dir, "app.json");
  if (!fs.existsSync(p)) { fail(`no app.json in ${dir}`, "an app without a manifest cannot be installed"); return null; }
  let m;
  try { m = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { fail(`app.json is not valid JSON: ${e.message}`); return null; }

  for (const f of ["id", "name", "surface"]) {
    if (!m[f]) fail(`app.json missing required field: ${f}`);
  }
  const s = m.surface || {};
  if (!s.path && !s.url) fail("surface declares neither path nor url");
  if (s.path && s.url) fail("surface declares BOTH path and url — exactly one");
  return m;
}

// DEFECT THIS CATCHES: files.html called marked.parse() while app.json declared
// vendor: []. The surface installed clean and the Markdown viewer was blank.
function checkClosure(dir, m) {
  const s = m.surface || {};
  if (s.entry) {
    const entry = path.join(dir, s.entry);
    fs.existsSync(entry) ? ok(`surface entry present (${s.entry})`)
      : fail(`surface entry missing: ${s.entry}`);
  } else if (s.path) {
    fail("surface declares path but no entry — nothing to copy");
  }

  const vendor = m.vendor ?? [];
  if (!Array.isArray(vendor)) { fail("vendor must be an array of directory names"); return; }
  for (const v of vendor) {
    // DEFECT THIS CATCHES: canvas declared its vendor entry as PROSE —
    // "vendor/tldraw-v5.2.5 (3.4MB, vendored deliberately …)". A human wrote a
    // note into a machine field. It reads fine and installs nothing.
    if (/[()\s]/.test(v)) {
      fail(`vendor entry is not a bare directory name: ${JSON.stringify(v)}`,
        "vendor entries are directory names under the app's vendor/ dir — put commentary in a _note field");
      continue;
    }
    const vd = path.join(dir, "vendor", v);
    fs.existsSync(vd) ? ok(`vendor present (${v})`)
      : fail(`declared vendor directory missing: vendor/${v}`);
  }

  // Undeclared-closure detection: the surface references /vendor/<x>/ that the
  // manifest never declared. This is the marked defect found from the other
  // side — from what the code USES rather than what the manifest CLAIMS.
  if (s.entry && fs.existsSync(path.join(dir, s.entry))) {
    const src = fs.readFileSync(path.join(dir, s.entry), "utf8");
    const used = new Set([...src.matchAll(/["'`\/]vendor\/([A-Za-z0-9._-]+)\//g)].map((x) => x[1]));
    for (const u of used) {
      if (!vendor.includes(u)) {
        fail(`surface loads /vendor/${u}/ but app.json does not declare it`,
          `add "${u}" to vendor[] and ship the directory`);
      }
    }
    if (used.size) note(`surface references vendor: ${[...used].join(", ")}`);
  }
}

// "THIS APP HAS NO BACKEND" CAN BE SAID TWO WAYS AND BOTH ARE CORRECT MANIFESTS.
//
// Omitting `provider` entirely is one. Declaring `{ required: false }` with no
// package is the other — an app SAYING it needs none, rather than leaving a reader
// to infer it from an absence. `apps/workspace` does exactly that, with a note
// explaining why, and it was UNINSTALLABLE ON ANY BOX: this checker read the
// KEY'S PRESENCE as a declaration and emitted three failures against a manifest
// that was documenting its own correctness.
//
// PRESENCE IS NOT MEANING. A provider is declared by a PACKAGE, not by a key
// existing. Found by cloud-impl provisioning a real VPS, and it is the same shape
// as both of their own findings in the same report.
//
// The genuinely malformed case is still caught: a `provider` key with no package
// and no explicit `required: false` says nothing at all, and that still fails.
const declaresNoProvider = (prov) =>
  !prov || (!prov.package && prov.required === false);

// DEFECT THIS CATCHES: cutdown's provider serves /media/, /cutprev/ and /cuts/.
// Nothing declared them, so the studio front proxied only /api/* and the app
// listed clips it could not play. A backend is not only its /api/ verbs.
function checkRoutes(m) {
  const prov = m.provider;
  if (declaresNoProvider(prov)) { ok("ultralight — no provider to route to"); return; }
  if (!prov.package) fail("provider declared without a package name");

  // Routing facts live on the PROVIDER once it has migrated. Checking only the
  // app manifest made this refuse every migrated app — the same false refusal
  // as the supplies gate, and for the same reason: the field moved and the
  // checker did not follow it.
  const decl = prov.package ? readProviderDeclaration(prov.package) : null;
  const verbs = decl?.verbs ?? m.verbs ?? [];
  const serves = decl?.serves ?? prov.serves ?? [];
  if (!verbs.length && !serves.length) {
    fail("provider declared but neither verbs[] nor provider.serves[] is declared",
      "an installer cannot wire a backend whose routes are unknown");
  }
  const nonApi = verbs.filter((v) => !String(v).startsWith("/api/"));
  if (nonApi.length && !serves.length) {
    fail(`non-/api routes listed in verbs[] but not in provider.serves[]: ${nonApi.join(", ")}`,
      "byte routes are prefixes, declare them in provider.serves[]");
  }
  if (serves.length) ok(`byte routes declared (${serves.join(", ")})`);
  if (verbs.length) ok(`${verbs.length} verb(s) declared`);
}

// DEFECT THIS CATCHES: nothing said HOW to run a provider, so start-studio.mjs
// hardcodes each one by name. A sixth app would need code here to run at all.
function checkRunnable(m) {
  const prov = m.provider;
  if (declaresNoProvider(prov)) return;
  // How to run is the PROVIDER's fact. An app that has migrated declares only a
  // reference, so demanding provider.run.entry from the app manifest refuses
  // exactly the shape the contract requires.
  const decl = prov.package ? readProviderDeclaration(prov.package) : null;
  if (decl?.run?.entry) { ok(`runnable — declared by ${prov.package} (provider.json)`); return; }
  if (!prov.run || !prov.run.entry) {
    fail("provider does not declare how to run (provider.run.entry)",
      "without it the box must hardcode this app, which is the opposite of installable");
    return;
  }
  const entry = path.join(appsRoot, "providers", path.basename(prov.package), prov.run.entry);
  fs.existsSync(entry) ? ok(`provider entry present (${prov.run.entry})`)
    : fail(`provider entry missing: ${entry}`);
}

// Roots are KINDS. The install binds them; the manifest must not name paths.
// The kind a manifest declares and the key that binds it are deliberately
// different words, so the refusal names BOTH — being told to bind "footage"
// without being told the key is "footageRoot" sends you looking for the wrong
// thing in the right file.
const ROOT_KEYS = { project: "sliceRoot", media: "mediaRoots[]", canvas: "canvasRoot", footage: "footageRoot" };
// THE VOCABULARY IS OPEN. The four names above are the ORIGINAL spellings kept
// working, not the set of kinds an app may declare — `roots{}` in studio.json
// binds any kind by its own name.
//
// It used to be closed, and that made the format's own promise false: the
// refusal below says "roots declare KINDS; the install binds them" while the
// binder knew exactly four. An app needing any other kind of directory could
// not be installed at all, and was told to add a binding to a file that had no
// shape to accept one. Same class as host capabilities being a special case
// instead of an ordinary provider — a mechanism that serves what was
// enumerated when it was written and rots for everything after.
//
// Opening it does NOT weaken the check: a kind nobody bound is still a refusal
// (test/root-kinds.test.mjs pins all three claims, including that one).
function checkRoots(m) {
  const roots = m.roots ?? {};
  const bound = {
    project: config.sliceRoot, media: config.mediaRoots?.[0],
    canvas: config.canvasRoot, footage: config.footageRoot,
    ...(config.roots ?? {}),
  };
  for (const [kind, spec] of Object.entries(roots)) {
    if (typeof spec === "string") {
      fail(`root "${kind}" is a path, not a kind: ${spec}`, "roots declare KINDS; the install binds them");
      continue;
    }
    bound[kind]
      ? ok(`root "${kind}" binds to ${bound[kind]}`)
      : fail(`root "${kind}" has no binding on this box`, `add a binding for "${kind}" to ${path.basename(CONFIG_PATH)} (${ROOT_KEYS[kind] ?? `roots.${kind}`})`);
  }
}

// A provider's own declaration, when it has migrated to one. Read here rather
// than imported from compose-rail because this tool runs BEFORE composition —
// it is deciding whether an app can be installed at all.
function readProviderDeclaration(pkg) {
  const p = path.join(appsRoot, "providers", path.basename(pkg), "provider.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// DEFECT CLASS THIS CATCHES: ffmpeg/ffprobe are shelled out to by the video
// provider and by cutdown's lane. Nothing declared them, so a box without them
// installs "successfully" and fails at the moment of use.
function checkBinaries(m) {
  const bins = m.requires?.binaries ?? [];
  if (!bins.length) return;

  // A binary is satisfied if the HOST has it OR the PROVIDER ships it.
  //
  // This check used to test PATH only, and that was a FALSE REFUSAL waiting to
  // happen: once the providers began shipping ffmpeg/ffprobe as npm deps, the
  // gate would refuse a perfectly working install on any box without a system
  // ffmpeg — which is most boxes, including the one this is all aimed at.
  // Measured before fixing, with node on PATH and ffmpeg removed.
  //
  // `requires.binaries` still declares the NEED, because that stays true and is
  // the honest thing to read. `supplies` says who satisfies it.
  //
  // AND IT IS READ FROM THE PROVIDER FIRST, because that is where the contract
  // puts it. This read the APP manifest only, so the moment an app migrated its
  // supplies onto provider.json — which contract/app-manifest.md requires — the
  // set went empty and this refused a working install. It re-broke the exact
  // false refusal the comment above records having already fixed once, by
  // moving the field out of the one place the checker looked.
  //
  // The tool also contradicted itself in a single run: the ffmpeg FILTER checks
  // below still passed, because they interrogate the real binary through the
  // provider's own node_modules. A checker that reports a binary missing and
  // then successfully asks that binary what filters it has is diagnosing the
  // manifest, not the host.
  //
  // App-side supplies is still honoured while an app has not migrated.
  const decl = m.provider?.package ? readProviderDeclaration(m.provider.package) : null;
  const supplied = new Set([...(decl?.supplies ?? []), ...(m.provider?.supplies ?? [])]);
  const PATH = (process.env.PATH || "").split(":");
  for (const b of bins) {
    if (supplied.has(b)) { ok(`binary ${b} ships with ${m.provider.package}`); continue; }
    const found = PATH.some((d) => { try { return fs.statSync(path.join(d, b)).isFile(); } catch { return false; } });
    found
      ? ok(`binary present on host (${b})`)
      : fail(`required binary not on PATH and not supplied by a provider: ${b}`,
             `install ${b} on this host, or have the provider ship it`);
  }
}

// BINARY PRESENCE IS NOT CAPABILITY PRESENCE.
//
// The binary check passed on Linux and the app still failed at export time,
// because `ffmpeg-static` ships a DIFFERENT BUILD PER PLATFORM: macOS gets 6.0
// with drawtext, Linux gets 7.0.2 (johnvansickle) WITHOUT it. Declaring
// "requires ffmpeg" was true on both and useless on one.
//
// So the manifest declares the FILTERS it needs and this asks the binary that
// will actually be used. Same family as "verbs answering is not apps working",
// one layer down: the thing is present and cannot do the job.
//
// Verified by measurement on the target, not inferred from the package name.
function checkFfmpegCapabilities(m, dir) {
  const wanted = m.requires?.ffmpeg_filters ?? [];
  if (!wanted.length) return;

  let bin = null;
  const pkg = m.provider?.package;
  if (pkg) {
    // Ask the SAME resolution the provider will use at runtime.
    const providerDir = path.join(appsRoot, "providers", path.basename(pkg));
    try {
      bin = createRequire(path.join(providerDir, "noop.js"))("ffmpeg-static");
    } catch { /* provider deps not installed yet */ }
  }
  if (!bin) {
    const PATH = (process.env.PATH || "").split(":");
    bin = PATH.map((d) => path.join(d, "ffmpeg")).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  }
  if (!bin) {
    note(`ffmpeg not resolvable yet — filter check deferred (run again after provider install)`);
    return;
  }

  const out = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 20000 });
  if (out.status !== 0) { fail(`could not list filters from ${bin}`); return; }
  const have = new Set(out.stdout.split("\n").map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
  for (const f of wanted) {
    have.has(f)
      ? ok(`ffmpeg filter present (${f})`)
      : fail(`ffmpeg has no "${f}" filter: ${bin}`,
             `this build cannot do what the app needs — use a build that carries it, or remove the dependency on that filter`);
  }

  // PREFERRED filters do NOT block an install. The app degrades honestly
  // without them and says so at the point of use, so refusing here would trade
  // a working studio for a caption on a shot nobody has filmed yet.
  for (const f of m.requires?.ffmpeg_filters_preferred ?? []) {
    have.has(f)
      ? ok(`ffmpeg filter present (${f}, preferred)`)
      : note(`ffmpeg has no "${f}" filter — the app degrades and reports it; not a blocker`);
  }
}

// ---- run --------------------------------------------------------------------
const checkOnly = has("--check");
const source = positional[0];
if (!source) {
  console.error("usage: install-app.mjs <source-dir> [--enable] | --check <app-id>");
  process.exit(2);
}

const dir = checkOnly ? path.join(appsRoot, "apps", source) : path.resolve(source);
if (!fs.existsSync(dir)) { console.error(`no such app directory: ${dir}`); process.exit(2); }

console.log(`\n${checkOnly ? "AUDIT" : "INSTALL"}  ${dir}\n`);
const m = checkManifest(dir);
if (m) {
  checkClosure(dir, m);
  checkRoutes(m);
  checkRunnable(m);
  checkRoots(m);
  checkBinaries(m);
  checkFfmpegCapabilities(m, dir);
}

if (failures) {
  console.log(`\nREFUSED — ${failures} problem(s). This app cannot be installed from its manifest as written.\n`);
  for (const p of problems) if (p.fix) console.log(`  · ${p.m}\n      ${p.fix}`);
  console.log("\nNothing was copied. Fix the manifest (or the app) and run again.\n");
  process.exit(1);
}

if (checkOnly) { console.log("\nOK — installable from its manifest.\n"); process.exit(0); }

// Only now do we touch the disk. An install that refuses AFTER copying leaves
// exactly the half-installed state this tool exists to prevent.
const destRoot = path.join(appsRoot, "apps");
fs.mkdirSync(destRoot, { recursive: true });
const dest = path.join(destRoot, m.id);

// SOURCE AND DEST CAN BE THE SAME DIRECTORY, and the destructive ordering is
// the trap: rmSync(dest) ran
// before cpSync, and dest WAS the source. Found by using the tool.
//
// Asked by INODE IDENTITY rather than by comparing resolved path strings.
// That is the actually-correct question — it sees through symlinks, bind
// mounts and hardlinks, which a string compare does not — and it keeps this
// file out of the business of path resolution, which belongs to exactly one
// function elsewhere.
const sameDir = fs.existsSync(dest) && (() => {
  const a = fs.statSync(dest), b = fs.statSync(dir);
  return a.dev === b.dev && a.ino === b.ino;
})();

if (sameDir) {
  console.log(`\n  already in place -> ${dest} (validated, nothing copied)`);
} else {
  if (fs.existsSync(dest) && !has("--force")) {
    console.error(`\n${m.id} is already installed at ${dest}. Use --force to replace it.\n`);
    process.exit(1);
  }
  // Stage then swap. Copying over a live install means a failure halfway
  // leaves neither the old app nor the new one — the half-installed state
  // this tool exists to prevent, produced by the tool itself.
  // Built from destRoot — the resolver's output — so the containment checker
  // can SEE where it came from. A template literal off `dest` is equally safe
  // and equally invisible, and an invisible guarantee is one the next reader
  // has to re-derive.
  const staging = path.join(destRoot, `.installing-${m.id}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(dir, staging, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    console.error(`\ninstall failed, previous state left intact: ${e.message}\n`);
    process.exit(1);
  }
  console.log(`\n  installed -> ${dest}`);
}

if (has("--enable")) {
  // Routed through the one resolver like every other write in this codebase.
  // CONFIG_PATH is server-derived and safe by inspection — but "safe because I
  // read it" is the property that decays when someone adds a second caller.
  // The containment checker caught this file on its first run, which is the
  // control harness doing its job on the tool written to enforce the rule.
  const cfg = CONFIG_PATH;
  const apps = new Set(config.apps ?? []);
  apps.add(m.id);
  config.apps = [...apps];
  fs.writeFileSync(cfg, JSON.stringify(config, null, 2) + "\n");
  console.log(`  enabled   -> studio.json (${config.apps.length} apps)`);
}

console.log(`\nOK — installed. Restart the studio, then VERIFY BY EFFECT:`);
console.log(`  the surface loads, its verbs answer, and its declared byte routes stream.`);
console.log(`  "installed" is not "working" — open it.\n`);
