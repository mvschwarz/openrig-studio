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
//   OPENRIG_STUDIO_DIR=<studio> node tools/install-app.mjs <source-dir> [--provider <provider-dir>] [--enable] [--force] [--allow-outside-imports]
//   OPENRIG_STUDIO_DIR=<studio> node tools/install-app.mjs --check <app-id>
//
// On a RELEASE-MANAGED workspace (tools/studio-release.mjs installed it), appsRoot
// is a generated code generation. The workspace's own code never goes there: the app (and its
// own provider, given with --provider) goes to extensions/apps|providers, which the
// release protects, and is linked into the current generation through the release
// library. Unmanaged studios keep installing into appsRoot as before.
//
// "Installed" here means REGISTERED: files in place and linked. It is not active
// until the running studio loads it (a restart, or a runtime activation that reports
// on the marker in .studio-release/extensions.json).
//
// Exit non-zero on any refusal. A half-installed app that looks fine is the
// failure this whole slice has been about.

import fs from "node:fs";
import { vendorDirectory } from "./vendor.mjs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  relinkExtensions,
  recordExtensions,
  runReleaseHelper,
} from "../lib/releases/workspace.mjs";

// The studio directory is given, not assumed — this tool ships with the SDK
// and installs into whatever studio you point it at.
const STUDIO = path.resolve(process.env.OPENRIG_STUDIO_DIR || process.cwd());
const CONFIG_PATH = path.join(STUDIO, "studio.json");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--provider");

const config = fs.existsSync(CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  : { apps: [], appsRoot: path.join(STUDIO, "apps") };
const appsRoot = path.resolve(STUDIO, (config.appsRoot ?? "apps").replace(/^~/, os.homedir()));
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
// Managed = the release library installed this workspace AND appsRoot resolves into
// its generations. Asked of the filesystem, not of a flag a caller could forget.
const releaseDir = real(path.join(STUDIO, ".studio-release"));
const MANAGED =
  !!releaseDir &&
  fs.existsSync(path.join(releaseDir, "installed.json")) &&
  (real(appsRoot) || "").startsWith(releaseDir + path.sep);
const EXTENSIONS = path.join(STUDIO, "extensions");
const providerSource = valueOf("--provider") ? path.resolve(valueOf("--provider")) : null;
if (has("--provider") && !valueOf("--provider")) {
  console.error("--provider needs the provider's directory");
  process.exit(2);
}
const providerSpec = providerSource
  ? (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(providerSource, "provider.json"), "utf8"));
      } catch {
        return null;
      }
    })()
  : null;
// Where a provider package lives for THIS install: the one being installed with
// --provider, one already in extensions/ (managed), or appsRoot.
function providerDir(pkg) {
  const b = path.basename(pkg);
  if (providerSpec?.package && path.basename(providerSpec.package) === b) return providerSource;
  if (MANAGED && fs.existsSync(path.join(EXTENSIONS, "providers", b)))
    return path.join(EXTENSIONS, "providers", b);
  return path.join(appsRoot, "providers", b);
}

let failures = 0;
const problems = [];
const ok = (m) => console.log(`  OK    ${m}`);
const fail = (m, fix) => {
  failures++;
  problems.push({ m, fix });
  console.log(`  FAIL  ${m}`);
};
const note = (m) => console.log(`  ·     ${m}`);

// ---- the checks -------------------------------------------------------------
// Each one exists because its absence produced a real defect. The comment names
// which, so nobody later "simplifies" a check whose cost is already paid.

function checkManifest(dir) {
  const p = path.join(dir, "app.json");
  if (!fs.existsSync(p)) {
    fail(`no app.json in ${dir}`, "an app without a manifest cannot be installed");
    return null;
  }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    fail(`app.json is not valid JSON: ${e.message}`);
    return null;
  }

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
    fs.existsSync(entry)
      ? ok(`surface entry present (${s.entry})`)
      : fail(`surface entry missing: ${s.entry}`);
  } else if (s.path) {
    fail("surface declares path but no entry — nothing to copy");
  }

  const vendor = m.vendor ?? [];
  if (!Array.isArray(vendor)) {
    fail("vendor must be an array of directory names");
    return;
  }
  for (const v of vendor) {
    // DEFECT THIS CATCHES: canvas declared its vendor entry as PROSE —
    // "vendor/tldraw-v5.2.5 (3.4MB, vendored deliberately …)". A human wrote a
    // note into a machine field. It reads fine and installs nothing.
    if (/[()\s]/.test(v)) {
      fail(
        `vendor entry is not a bare directory name: ${JSON.stringify(v)}`,
        "vendor entries are directory names under the app's vendor/ dir — put commentary in a _note field",
      );
      continue;
    }
    const vd = vendorDirectory(appsRoot, dir, v);
    fs.existsSync(vd)
      ? ok(`vendor present (${v})`)
      : fail(`declared vendor directory missing: vendor/${v}`);
  }

  // Undeclared-closure detection: the surface references /vendor/<x>/ that the
  // manifest never declared. This is the marked defect found from the other
  // side — from what the code USES rather than what the manifest CLAIMS.
  if (s.entry && fs.existsSync(path.join(dir, s.entry))) {
    const src = fs.readFileSync(path.join(dir, s.entry), "utf8");
    const used = new Set([...src.matchAll(/["'`/]vendor\/([A-Za-z0-9._-]+)\//g)].map((x) => x[1]));
    for (const u of used) {
      if (!vendor.includes(u)) {
        fail(
          `surface loads /vendor/${u}/ but app.json does not declare it`,
          `add "${u}" to vendor[] and ship the directory`,
        );
      }
    }
    if (used.size) note(`surface references vendor: ${[...used].join(", ")}`);
  }
}

// "THIS APP HAS NO BACKEND" CAN BE SAID TWO WAYS AND BOTH ARE CORRECT MANIFESTS.
//
// Omitting `provider` entirely is one. Declaring `{ required: false }` with no
// package is the other — an app SAYING it needs none, rather than leaving a reader
// to infer it from an absence. Reading the KEY'S PRESENCE as a declaration would
// fail a manifest that is documenting its own correctness.
//
// PRESENCE IS NOT MEANING. A provider is declared by a PACKAGE, not by a key
// existing.
//
// The genuinely malformed case is still caught: a `provider` key with no package
// and no explicit `required: false` says nothing at all, and that still fails.
const declaresNoProvider = (prov) => !prov || (!prov.package && prov.required === false);

// DEFECT THIS CATCHES: cutdown's provider serves /media/, /cutprev/ and /cuts/.
// Nothing declared them, so the studio front proxied only /api/* and the app
// listed clips it could not play. A backend is not only its /api/ verbs.
function checkRoutes(m) {
  const prov = m.provider;
  if (declaresNoProvider(prov)) {
    ok("ultralight — no provider to route to");
    return;
  }
  if (!prov.package) fail("provider declared without a package name");

  // Routing facts live on the PROVIDER once it has migrated. Checking only the
  // app manifest made this refuse every migrated app — the same false refusal
  // as the supplies gate, and for the same reason: the field moved and the
  // checker did not follow it.
  const decl = prov.package ? readProviderDeclaration(prov.package) : null;
  const verbs = decl?.verbs ?? m.verbs ?? [];
  const serves = decl?.serves ?? prov.serves ?? [];
  if (!verbs.length && !serves.length) {
    fail(
      "provider declared but neither verbs[] nor provider.serves[] is declared",
      "an installer cannot wire a backend whose routes are unknown",
    );
  }
  const nonApi = verbs.filter((v) => !String(v).startsWith("/api/"));
  if (nonApi.length && !serves.length) {
    fail(
      `non-/api routes listed in verbs[] but not in provider.serves[]: ${nonApi.join(", ")}`,
      "byte routes are prefixes, declare them in provider.serves[]",
    );
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
  if (decl?.run?.entry) {
    ok(`runnable — declared by ${prov.package} (provider.json)`);
    return;
  }
  if (!prov.run || !prov.run.entry) {
    fail(
      "provider does not declare how to run (provider.run.entry)",
      "without it the box must hardcode this app, which is the opposite of installable",
    );
    return;
  }
  const entry = path.join(providerDir(prov.package), prov.run.entry);
  fs.existsSync(entry)
    ? ok(`provider entry present (${prov.run.entry})`)
    : fail(`provider entry missing: ${entry}`);
}

// Roots are KINDS. The install binds them; the manifest must not name paths.
// The kind a manifest declares and the key that binds it are deliberately
// different words, so the refusal names BOTH — being told to bind "footage"
// without being told the key is "footageRoot" sends you looking for the wrong
// thing in the right file.
const ROOT_KEYS = {
  project: "sliceRoot",
  media: "mediaRoots[]",
  canvas: "canvasRoot",
  footage: "footageRoot",
};
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
    project: config.sliceRoot,
    media: config.mediaRoots?.[0],
    canvas: config.canvasRoot,
    footage: config.footageRoot,
    ...(config.roots ?? {}),
  };
  for (const [kind, spec] of Object.entries(roots)) {
    if (typeof spec === "string") {
      fail(
        `root "${kind}" is a path, not a kind: ${spec}`,
        "roots declare KINDS; the install binds them",
      );
      continue;
    }
    // Only an explicit "required": false makes a root optional: an unbound optional root is reported and the install goes
    // on (the app works without it, contract/app-manifest.md). Every other declared root must be bound.
    if (bound[kind]) ok(`root "${kind}" binds to ${bound[kind]}`);
    else if (spec?.required === false)
      note(
        `root "${kind}" is optional and has no binding on this box; the app works without it (bind it in ${path.basename(CONFIG_PATH)}, ${ROOT_KEYS[kind] ?? `roots.${kind}`}, to use it)`,
      );
    else
      fail(
        `root "${kind}" has no binding on this box`,
        `add a binding for "${kind}" to ${path.basename(CONFIG_PATH)} (${ROOT_KEYS[kind] ?? `roots.${kind}`})`,
      );
  }
}

// A provider's own declaration, when it has migrated to one. Read here rather
// than imported from compose-rail because this tool runs BEFORE composition —
// it is deciding whether an app can be installed at all.
function readProviderDeclaration(pkg) {
  const p = path.join(providerDir(pkg), "provider.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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
    if (supplied.has(b)) {
      ok(`binary ${b} ships with ${m.provider.package}`);
      continue;
    }
    const found = PATH.some((d) => {
      try {
        return fs.statSync(path.join(d, b)).isFile();
      } catch {
        return false;
      }
    });
    found
      ? ok(`binary present on host (${b})`)
      : fail(
          `required binary not on PATH and not supplied by a provider: ${b}`,
          `install ${b} on this host, or have the provider ship it`,
        );
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
function checkFfmpegCapabilities(m) {
  const wanted = m.requires?.ffmpeg_filters ?? [];
  if (!wanted.length) return;

  let bin = null;
  const pkg = m.provider?.package;
  if (pkg) {
    // Ask the SAME resolution the provider will use at runtime.
    try {
      bin = createRequire(path.join(providerDir(pkg), "noop.js"))("ffmpeg-static");
    } catch {
      /* provider deps not installed yet */
    }
  }
  if (!bin) {
    const PATH = (process.env.PATH || "").split(":");
    bin = PATH.map((d) => path.join(d, "ffmpeg")).find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
  }
  if (!bin) {
    note(`ffmpeg not resolvable yet — filter check deferred (run again after provider install)`);
    return;
  }

  const out = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 20000 });
  if (out.status !== 0) {
    fail(`could not list filters from ${bin}`);
    return;
  }
  const have = new Set(
    out.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean),
  );
  for (const f of wanted) {
    have.has(f)
      ? ok(`ffmpeg filter present (${f})`)
      : fail(
          `ffmpeg has no "${f}" filter: ${bin}`,
          `this build cannot do what the app needs — use a build that carries it, or remove the dependency on that filter`,
        );
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

// The provider given with --provider must be the one the app names, and runnable.
function checkProvider(m) {
  if (!providerSource) return;
  if (!providerSpec) {
    fail(`no valid provider.json in ${providerSource}`);
    return;
  }
  if (typeof providerSpec.package !== "string" || !providerSpec.package) {
    fail("provider.json declares no package");
    return;
  }
  if (path.basename(providerSpec.package) !== path.basename(m.provider?.package || ""))
    fail(
      `--provider is ${providerSpec.package}, but the app names ${m.provider?.package || "no provider"}`,
      "give the provider this app declares in provider.package",
    );
  if (!providerSpec.run?.entry || !fs.existsSync(path.join(providerSource, providerSpec.run.entry)))
    fail(
      "the provider's run.entry is missing",
      "a provider is installable only with the file it runs",
    );
  else ok(`provider ${providerSpec.package} ships its entry (${providerSpec.run.entry})`);
}

// DEFECT THIS CATCHES: a provider whose entry imports ../lib/<shared>.mjs, a file beside
// its folder in the tree it came from. Only the provider's own folder is copied, so the
// installed copy crash-looped with ERR_MODULE_NOT_FOUND while every check here passed.
// Follow the relative imports from run.entry (static, re-exports and literal dynamic
// imports) and refuse any that leave the copied folder, naming the import.
// Read literal module references without mistaking comments, examples or regex bodies for code.
// Computed dynamic imports remain runtime choices; this check never executes provider code.
function moduleReferences(source) {
  const tokens = [],
    braces = [];
  let i = 0,
    canRegex = true;
  const escaped = () => {
    const c = source[i++],
      simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
    if (c === "\n") return "";
    if (c === "\r") {
      if (source[i] === "\n") i++;
      return "";
    }
    if (c === "x" && /^[0-9a-f]{2}$/i.test(source.slice(i, i + 2))) {
      const n = parseInt(source.slice(i, i + 2), 16);
      i += 2;
      return String.fromCharCode(n);
    }
    if (c === "u") {
      const m = /^(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{4}))/i.exec(source.slice(i));
      if (m && parseInt(m[1] || m[2], 16) <= 0x10ffff) {
        i += m[0].length;
        return String.fromCodePoint(parseInt(m[1] || m[2], 16));
      }
    }
    return simple[c] ?? c;
  };
  const template = () => {
    let value = "";
    while (i < source.length) {
      if (source[i] === "`") {
        i++;
        return { open: false, value };
      }
      if (source.startsWith("${", i)) {
        i += 2;
        return { open: true, value };
      }
      if (source[i] === "\\") {
        i++;
        value += escaped();
      } else value += source[i++];
    }
    return { open: false, value };
  };
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      i = source.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      let value = "";
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          i++;
          value += escaped();
        } else value += source[i++];
      }
      i++;
      tokens.push({ kind: "string", value });
      canRegex = false;
      continue;
    }
    // A template: its text up to the closing ` or a ${. A substitution is tokenized as code (nested templates included); its } resumes
    // the template.
    if (c === "`") {
      i++;
      const t = template();
      if (t.open) {
        tokens.push({ kind: "computed", value: "" });
        braces.push("${");
        canRegex = true;
      } else {
        tokens.push({ kind: "string", value: t.value });
        canRegex = false;
      }
      continue;
    }
    if (c === "}" && braces.at(-1) === "${") {
      braces.pop();
      i++;
      const t = template();
      if (t.open) {
        braces.push("${");
        canRegex = true;
      } else canRegex = false;
      continue;
    }
    if (c === "/" && canRegex) {
      i++;
      let cls = false;
      while (i < source.length) {
        const r = source[i++];
        if (r === "\\") i++;
        else if (r === "[") cls = true;
        else if (r === "]") cls = false;
        else if (r === "/" && !cls) break;
      }
      while (/[a-z]/i.test(source[i] || "") && i < source.length) i++;
      tokens.push({ kind: "regex", value: "" });
      canRegex = false;
      continue;
    }
    const number = /^(?:0[xob][\da-f_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?n?)/i.exec(
      source.slice(i),
    );
    if (number) {
      i += number[0].length;
      tokens.push({ kind: "number", value: number[0] });
      canRegex = false;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
    if (word) {
      i += word[0].length;
      tokens.push({ kind: "word", value: word[0] });
      canRegex = ["return", "throw", "case", "typeof", "void", "delete", "yield"].includes(word[0]);
      continue;
    }
    if (c === "{") braces.push("{");
    else if (c === "}") braces.pop();
    i++;
    tokens.push({ kind: "punctuation", value: c });
    canRegex = ![")", "]", "}"].includes(c);
  }
  const references = [];
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n],
      next = tokens[n + 1];
    if (t.kind !== "word" || tokens[n - 1]?.value === ".") continue;
    // Only a string that IS the whole first argument names a module: import("./" + name) is a runtime choice.
    if (
      (t.value === "import" || t.value === "require") &&
      next?.value === "(" &&
      tokens[n + 2]?.kind === "string" &&
      [")", ","].includes(tokens[n + 3]?.value)
    )
      references.push({ spec: tokens[n + 2].value, require: t.value === "require" });
    else if (t.value === "import" && next?.kind === "string") references.push({ spec: next.value });
    else if (
      (t.value === "import" && next?.value !== ".") ||
      (t.value === "export" && ["{", "*"].includes(next?.value))
    ) {
      for (let j = n + 1; j < tokens.length && tokens[j].value !== ";"; j++) {
        if (
          tokens[j].kind === "word" &&
          tokens[j].value === "from" &&
          tokens[j + 1]?.kind === "string"
        ) {
          references.push({ spec: tokens[j + 1].value });
          break;
        }
      }
    }
  }
  return references;
}
function checkProviderImports() {
  if (!providerSource || !providerSpec?.run?.entry) return;
  const root = fs.realpathSync(providerSource),
    seen = new Set(),
    queue = [path.join(root, providerSpec.run.entry)],
    outside = [],
    unread = [];
  const inside = (p) => {
    const rel = path.relative(root, p);
    return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  };
  let entry = queue[0];
  try {
    entry = fs.realpathSync(entry);
  } catch {}
  if (!inside(queue[0]) || !inside(entry)) {
    fail(
      "the provider's run.entry is outside its own folder: " + providerSpec.run.entry,
      "ship the entry inside the provider's folder",
    );
    return;
  }
  while (queue.length) {
    let file;
    try {
      file = fs.realpathSync(queue.pop());
    } catch {
      continue;
    } // a missing file is the runtime's own error (run.entry is checked above)
    if (seen.has(file)) continue;
    // Only JavaScript is read (.mjs, .cjs, .js): anything else (a .ts or .mts entry) isn't checked, and the result says so.
    if (!/\.(?:mjs|cjs|js)$/.test(file)) {
      seen.add(file);
      unread.push(path.relative(root, file));
      continue;
    }
    seen.add(file);
    for (const { spec, require: cjs } of moduleReferences(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("file:")) continue; // packages resolve from node_modules
      let target;
      try {
        target = cjs
          ? createRequire(file).resolve(spec)
          : fileURLToPath(new URL(spec, pathToFileURL(file)));
      } catch {
        try {
          target = fileURLToPath(new URL(spec, pathToFileURL(file)));
        } catch {
          outside.push(`${path.relative(root, file)} imports ${spec}`);
          continue;
        }
      }
      let resolved = target;
      try {
        resolved = fs.realpathSync(target);
      } catch {
        /* a missing file remains the runtime's error */
      }
      if (!inside(target) || !inside(resolved))
        outside.push(`${path.relative(root, file)} imports ${spec}`);
      else queue.push(target);
    }
  }
  // The scan reads source text and can be wrong. --allow-outside-imports is the owner's say-so: install anyway, and the runtime decides,
  // so a misread never leaves a working provider uninstallable.
  if (outside.length && has("--allow-outside-imports"))
    note(
      `installing anyway (--allow-outside-imports): the provider seems to import files outside its own folder: ${outside.join("; ")}`,
    );
  else if (outside.length)
    fail(
      `the provider imports files outside its own folder, and only that folder is installed: ${outside.join("; ")}`,
      "ship those files inside the provider's folder. A provider that ships with the Studio release is already in its code generation: enable it there instead of installing it. If this reading is wrong and the provider runs as it is, add --allow-outside-imports",
    );
  else if (unread.length)
    note(
      `the provider's imports weren't checked in ${unread.join(", ")} (only .mjs, .cjs and .js are read); the JavaScript that was read stays inside its folder`,
    );
  else ok("the provider's imports stay inside its folder");
}

// fs.cpSync does not keep file modes; an installed provider script must keep its own.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name),
      b = path.join(to, e.name),
      mode = fs.lstatSync(a).mode & 0o777;
    if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(a), b);
    else if (e.isDirectory()) {
      copyTree(a, b);
      fs.chmodSync(b, mode);
    } else if (e.isFile()) {
      fs.copyFileSync(a, b);
      fs.chmodSync(b, mode);
    }
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
if (!fs.existsSync(dir)) {
  console.error(`no such app directory: ${dir}`);
  process.exit(2);
}

console.log(`\n${checkOnly ? "AUDIT" : "INSTALL"}  ${dir}\n`);
const m = checkManifest(dir);
if (m) {
  checkClosure(dir, m);
  checkRoutes(m);
  checkProvider(m);
  checkProviderImports();
  checkRunnable(m);
  checkRoots(m);
  checkBinaries(m);
  checkFfmpegCapabilities(m);
}

if (failures) {
  console.log(
    `\nREFUSED — ${failures} problem(s). This app cannot be installed from its manifest as written.\n`,
  );
  for (const p of problems) if (p.fix) console.log(`  · ${p.m}\n      ${p.fix}`);
  console.log("\nNothing was copied. Fix the manifest (or the app) and run again.\n");
  process.exit(1);
}

if (checkOnly) {
  console.log("\nOK — installable from its manifest.\n");
  process.exit(0);
}

// Only now do we touch the disk. An install that refuses AFTER copying leaves
// exactly the half-installed state this tool exists to prevent.
const items = [
  {
    kind: "app",
    from: dir,
    parent: MANAGED ? path.join(EXTENSIONS, "apps") : path.join(appsRoot, "apps"),
    name: m.id,
  },
];
if (providerSource)
  items.push({
    kind: "provider",
    from: providerSource,
    parent: MANAGED ? path.join(EXTENSIONS, "providers") : path.join(appsRoot, "providers"),
    name: path.basename(providerSpec.package),
  });

// SOURCE AND DEST CAN BE THE SAME DIRECTORY, and the destructive ordering is
// the trap: rmSync(dest) ran before cpSync, and dest WAS the source. Found by
// using the tool. Asked by INODE IDENTITY rather than by comparing resolved path
// strings: it sees through symlinks, bind mounts and hardlinks.
for (const it of items) {
  it.dest = path.join(it.parent, it.name);
  it.existed = fs.existsSync(it.dest);
  it.same =
    it.existed &&
    (() => {
      const a = fs.statSync(it.dest),
        b = fs.statSync(it.from);
      return a.dev === b.dev && a.ino === b.ino;
    })();
  if (it.existed && !it.same && !has("--force")) {
    console.error(`\n${it.name} is already installed at ${it.dest}. Use --force to replace it.\n`);
    process.exit(1);
  }
}
// Stage then swap, keeping the previous copy until the whole install (and, on a
// managed workspace, the relink) succeeded. A failure restores what was there.
const swapped = [];
let linked = null;
function restore() {
  for (const it of swapped.reverse()) {
    fs.rmSync(it.dest, { recursive: true, force: true });
    if (it.backup) fs.renameSync(it.backup, it.dest);
  }
}
try {
  for (const it of items) {
    if (it.same) {
      console.log(`\n  already in place -> ${it.dest} (validated, nothing copied)`);
      continue;
    }
    fs.mkdirSync(it.parent, { recursive: true });
    // Built from the parent — the resolver's output — so the containment checker can see where it came from.
    // Managed: stage and back up outside extensions/, where every entry is read as an extension.
    const work = MANAGED ? path.join(releaseDir, ".installing") : it.parent;
    fs.mkdirSync(work, { recursive: true });
    const staging = path.join(work, `.installing-${it.name}-${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      copyTree(it.from, staging);
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    if (it.existed) {
      it.backup = path.join(work, `.previous-${it.name}-${process.pid}`);
      fs.rmSync(it.backup, { recursive: true, force: true });
      fs.renameSync(it.dest, it.backup);
    }
    fs.renameSync(staging, it.dest);
    swapped.push(it);
  }
  if (MANAGED) {
    linked = relinkExtensions({ workspace: STUDIO, keepLocal: has("--keep-local"), record: false });
    if (linked.outcome !== "done")
      throw Error(linked.reason || `the release library answered ${linked.outcome}`);
    for (const it of items)
      console.log(
        `\n  ${it.existed ? "updated" : "registered"} -> ${path.relative(STUDIO, it.dest)} (workspace-owned)${linked.noop ? ", already linked" : ", linked into the current code generation"}`,
      );
  } else for (const it of swapped) console.log(`\n  installed -> ${it.dest}`);
} catch (e) {
  restore();
  console.error(`\ninstall failed, previous state restored: ${e.message}\n`);
  process.exit(1);
}
for (const it of swapped) if (it.backup) fs.rmSync(it.backup, { recursive: true, force: true });

// THE REGISTRATION RECORD IS WRITTEN LAST: after the files, the link and the enable,
// so a runtime that reacts to its marker already reads the final studio.json.
function recordRegistration(enabled) {
  const copied = swapped.map((it) => `${it.kind === "app" ? "apps" : "providers"}/${it.name}`);
  if (!copied.length && !(linked && !linked.noop) && !enabled) return;
  const changes = linked && !linked.noop ? linked.extensionChanges : { updated: copied };
  recordExtensions(
    STUDIO,
    { kind: items.some((it) => !it.existed) ? "registered" : "updated", changes, enabled },
    MANAGED ? {} : { appsRoot },
  );
}

if (has("--enable")) {
  // Routed through the one resolver like every other write in this codebase.
  // CONFIG_PATH is server-derived and safe by inspection — but "safe because I
  // read it" is the property that decays when someone adds a second caller.
  // The containment checker caught this file on its first run, which is the
  // control harness doing its job on the tool written to enforce the rule.
  const cfg = CONFIG_PATH;
  // A release adoption can change appsRoot while this app is being copied.
  // Reread/merge only apps under the same stable settings lock, retaining edits.
  let enabled;
  try {
    enabled = runReleaseHelper(["--enable-app", cfg], {
      input: JSON.stringify({ expected: config.appsRoot ?? null, app: m.id, initial: config }),
      encoding: "utf8",
      timeout: 10000,
    });
  } catch (e) {
    enabled = { status: 1, stderr: e.message };
  }
  if (enabled.status !== 0) {
    console.error(
      enabled.stderr ||
        "The app was installed but could not be enabled. Inspect studio.json before retrying.",
    );
    recordRegistration(false);
    process.exit(1);
  }
  console.log(`  enabled   -> studio.json (${JSON.parse(enabled.stdout).apps} apps)`);
}
recordRegistration(has("--enable"));

console.log(
  `\nOK — registered, not yet active: the files are in place, and the running studio has not loaded them.`,
);
console.log(
  `  Restart the studio (or let a runtime that watches .studio-release/extensions.json activate it), then VERIFY BY EFFECT:`,
);
console.log(`  the surface loads, its verbs answer, and its declared byte routes stream.`);
if (MANAGED)
  console.log(
    `  Activation is reported, not assumed: node tools/studio-release.mjs inspect --workspace ${STUDIO}  (extensions.activation)`,
  );
console.log(`  "installed" is not "working" — open it.\n`);
