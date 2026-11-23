#!/usr/bin/env node
// BOOT A STUDIO: compose the rail, run every provider it needs, own one origin.
//
// WHY THIS SHIPS WITH THE SDK. The runtime serves SURFACES. It does not run the
// backends those surfaces call, and it does not route to them. Without this,
// a heavy app INSTALLS and cannot WORK: its verbs 404 and its media never
// streams. That is the difference between distributing an app and distributing
// a working app.
//
// Surfaces are served by the runtime, so their relative /api/... calls must
// arrive at the SAME ORIGIN. This process owns the public port and proxies:
// declared provider routes to that provider, everything else to the runtime.
//
//   OPENRIG_STUDIO_DIR=<studio> node tools/studio.mjs [--port 8890]
//
// With an explicit port n, the public port is n, the runtime n+1, providers
// from n+2, and one more after those is reserved as the seat terminals' marker
// (they listen on a private Unix socket, never on it). Port 0 asks the OS for
// every one of them instead, and the "studio: http://..." line reports the
// public port it got.
//
// studio.json: { apps: [], appsRoot, port, doors?, and one binding per root KIND }

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { composeRail, writeOverlayManifest } from "./compose-rail.mjs";
import {
  liveComposition,
  readExtensions,
  refreshExtensions,
  snapshotExtensions,
} from "./runtime-extensions.mjs";
import { isRuntimeOwned } from "../app/verbs.mjs";
import {
  resolveRoster,
  resolveRig,
  rigNodeArgs,
  createRosterRefresh,
  DECLARED,
  UNREACHABLE,
} from "./seat-roster.mjs";
import { vendorFile, notModified, VENDOR_CACHE } from "./vendor.mjs";
import { createTerminals } from "./terminal.mjs";
import { createHostedTerminals } from "./hosted-terminals.mjs";
import { TTYD_QUIET, forwardTtydLog } from "./ttyd-log.mjs";
import {
  allowedHostsFrom,
  healthDetailAllowed,
  hooksPath,
  isHealth,
  loadServerHooks,
  notifyHealth,
  refuseUpgrade,
} from "./server-hooks.mjs";
import {
  DESKTOP_PATH,
  desktopAnswering,
  originsFrom,
  readDesktopTarget,
  upgradeDesktop,
} from "./desktop.mjs";
import { KEY_ENV, KEY_HEADER } from "./child-key.mjs";
import { createSeatSocket, isChatPath, proxyChatPage, upgradeChat } from "./seat-terminal.mjs";
import { createSupervisor, listening } from "./supervise.mjs";
import { allocatePorts } from "./ports.mjs";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const STUDIO = path.resolve(process.env.OPENRIG_STUDIO_DIR || process.cwd());
const cfgPath = path.join(STUDIO, "studio.json");
if (!fs.existsSync(cfgPath)) {
  console.error(`studio: no studio.json in ${STUDIO}. Scaffold one with create-studio.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
// Sample data is an explicit choice. A normal Studio reads its configured
// workspace or reports why that source cannot be read.
const MODE = config.mode || process.env.STUDIO_MODE || "workspace";
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i > -1 && argv[i + 1] ? argv[i + 1] : d;
};
const requestedPort = Number(arg("--port", String(config.port ?? 8890)));
const appsRoot = path.resolve(STUDIO, (config.appsRoot ?? "apps").replace(/^~/, os.homedir()));
const RUNTIME = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "app",
  "serve-studio.mjs",
);

// ---- who owns .runtime/ ----------------------------------------------------
//
// TWO STUDIOS SHARING ONE STUDIO_DIR SHARE .runtime/, AND COMPOSING IS
// DESTRUCTIVE. The second to boot would repaint the first's rail, and the first
// cannot notice, because it built its routing table IN MEMORY at ITS boot and
// never reads the directory again.
//
// The result would be an app that is PRESENT, LOOKS INSTALLED, AND CANNOT WORK:
// its tab loads 200 while every verb behind it 404s, because the process serving
// it has never heard of the provider whose row it is showing. None of the
// obvious checks catch it — the row is real, the page is real, and the 200 is
// real.
//
// So the SECOND boot refuses rather than winning quietly. Same rule as the port
// guard and the systemd unit: REFUSE RATHER THAN ADOPT.
//
// LIVENESS IS THE STAMPED PORT, NOT THE STAMPED PID. A pid can be reused by
// anything, so a dead studio whose number came round again would refuse a
// legitimate boot forever. What matters is whether something is still SERVING
// from this .runtime, so that is what gets asked.
const RUNTIME_DIR = path.join(STUDIO, ".runtime");
const OWNER_FILE = path.join(RUNTIME_DIR, "owner.json");

// Deliberately does not ask WHO answers: a stranger on that port is still a
// reason to refuse, and asking the studio would mean trusting a reply from the
// process we are unsure about.
const portIsServing = (p) =>
  new Promise((resolve) => {
    const s = net.connect(Number(p), "127.0.0.1");
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 700);
  });

let priorOwner = null;
try {
  priorOwner = JSON.parse(fs.readFileSync(OWNER_FILE, "utf8"));
} catch {}

if (priorOwner && Number(priorOwner.port) !== requestedPort) {
  if (await portIsServing(priorOwner.port)) {
    console.error(
      "studio: .runtime/ in " + STUDIO + " is in use by the studio on port " + priorOwner.port,
    );
    console.error(
      "  (pid " + (priorOwner.pid ?? "?") + ", started " + (priorOwner.startedAt ?? "?") + ")",
    );
    console.error("  Composing would REPAINT that studio's rail while it keeps serving the one it");
    console.error("  built at ITS boot — its tabs would load and their verbs would 404, and it");
    console.error("  cannot detect the change. Refusing rather than corrupting a running studio.");
    console.error(
      "  Give this studio its own OPENRIG_STUDIO_DIR, or stop port " + priorOwner.port + " first.",
    );
    process.exit(7);
  }
  // Stale stamp: the owner is gone. Take over and SAY SO — a silent takeover
  // here is the same silence this guard exists to remove, with nobody harmed
  // this time.
  console.log(
    "  runtime : taking over .runtime/ from a studio on port " +
      priorOwner.port +
      " that is no longer serving",
  );
}
// ---- compose ---------------------------------------------------------------
// The registration record an install or release last wrote (tools/runtime-extensions.mjs). A workspace without one is
// baselined from what it composes now, so its first install reloads only what that install changed.
let extensionBaseline = null;
try {
  extensionBaseline = readExtensions(STUDIO);
} catch (e) {
  console.error("studio: extension state unreadable — " + e.message);
}
const rail = composeRail({
  appsRoot,
  enabled: config.apps ?? [],
  doors: config.doors ?? [],
  runtimeDir: path.join(STUDIO, ".runtime"),
  studioRoot: STUDIO,
  log: (m) => console.log(`  app     : ${m}`),
});
if (!extensionBaseline && !fs.existsSync(path.join(STUDIO, ".studio-release/current")))
  extensionBaseline = snapshotExtensions(appsRoot, rail);
// The runtime and /vendor/ read the composition through one pointer, so a live activation swaps it whole.
liveComposition(STUDIO, rail, extensionBaseline, appsRoot);
// Every port this studio listens on, in order: public, runtime, one per
// provider, then the seat terminal (reserved even when no terminal runs).
// Port 0 asks the OS for all of them at once, so they are distinct, and each is
// one the OS has just handed out rather than a neighbour it may hand out next.
const reservePorts = (count) =>
  Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise((resolve, reject) => {
          const s = net.createServer();
          s.once("error", reject);
          s.listen(0, "127.0.0.1", () => resolve(s));
        }),
    ),
  ).then((servers) =>
    Promise.all(
      servers.map((s) => {
        const p = s.address().port;
        return new Promise((resolve) => s.close(() => resolve(p)));
      }),
    ),
  );
const portCount = 3 + rail.providers.size;
// A fixed port keeps the public port and the runtime (port + 1) as the studio's identity; providers and the seat
// terminal step over any port another process is already serving (tools/ports.mjs), so two studios on one machine run
// side by side. The guard below still refuses a port that turns out to be taken at bind time.
const fixedPorts = async (base) => {
  const a = await allocatePorts({
    base,
    providers: [...rail.providers],
    wantSeat: true,
    inUse: async (p) => (await listening(p)) === true,
  });
  return [
    base,
    a.sdkPort,
    ...[...rail.providers].map((pkg) => a.providerPorts.get(pkg)),
    a.seatPort,
  ];
};
const ports = requestedPort === 0 ? await reservePorts(portCount) : await fixedPorts(requestedPort);
const port = ports[0];
// Claim it only once the compose actually happened.
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(
    OWNER_FILE,
    JSON.stringify(
      { pid: process.pid, port, studioRoot: STUDIO, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
} catch (e) {
  // Not fatal — a studio that cannot stamp still runs. But an unstamped
  // .runtime/ is one the NEXT boot will silently take, so it is said out loud.
  console.error(
    "  warn    : could not stamp .runtime/ ownership (" +
      e.message +
      ") — a second boot will not be warned",
  );
}
for (const m of rail.missing) console.error(`  MISSING : ${m}`);
for (const w of rail.warnings ?? []) console.error(`  warn    : ${w}`);

// A declared CALL that nothing answers. The third rung of the ladder in
// contract/app-manifest.md: an app that cannot work without a verb must not
// come up looking healthy, for the same reason a missing companion refuses —
// the surface loads, the verb 404s, and only the product is broken.
//
// Refusals are collected rather than thrown one at a time so an operator fixing
// an install sees every problem in one run instead of peeling them off across
// five restarts.
if ((rail.refusals ?? []).length) {
  console.error("studio: a required dependency is unsatisfiable on this box:");
  for (const r of rail.refusals) console.error(`  ${r}`);
  console.error("Refusing to start rather than serve apps whose required verbs 404.");
  process.exit(1);
}

// A door is not an app: declared-but-absent is a BROKEN INSTALL, not an empty
// studio, and it must not come up looking healthy.
const declared = (config.apps ?? []).length;
// Counts rows that came from an APP. A door is box composition and so are the
// studio's own surfaces, so neither may satisfy this guard — otherwise a studio
// with a surface of its own would come up looking healthy while every app it
// declared failed to compose, which is the exact camouflage the check exists to
// remove.
const ownIds = new Set(rail.ownSurfaceIds ?? []);
const composed = rail.rows.filter(
  (r) => !(config.doors ?? []).some((d) => d.id === r.id) && !ownIds.has(r.id),
).length;
if (declared && !composed) {
  console.error(
    `studio: ${declared} app(s) enabled and NONE composed. Refusing to start and look healthy.`,
  );
  process.exit(1);
}
// ---- the seat roster: derived, never authored ------------------------------
// The sidebar is the point of this shell — a human and the agents that wrote
// the app, on one screen. Its roster is RUNTIME state, so it is derived from
// the live rig at boot and never written back into a source-controlled file.
//
// The roster and the attach allowlist are the SAME ARTIFACT, not two
// derivations of one property: seat-attach.sh authorizes against the composed
// manifest written below, handed to it as OPENRIG_STUDIO_SEATS. This comment
// used to say the two "check the same live rig" and therefore a tile could
// never exist for a seat that refuses to attach — retired mechanism, and false
// twice over, because a configured member that is not running is on the roster
// and cannot be attached to. Second stale comment caught in this pair; both
// were true when written and made false by an edit elsewhere.
//
// No rig is a normal state, not an error: the roster is simply absent and the
// shell says so. A studio need not be attached to a rig; it must know whether
// it is.
//
// PRECEDENCE, and it replaces a fleet-wide union. This used to run
// `rig ps --nodes -A` and put EVERY node on the box into the sidebar — measured
// here: 92 across 12 rigs, of which 53 running, 25 detached and 14 exited, all
// printed as "live". It also passed that roster unconditionally, so a studio's
// own declared `chatSeats` was discarded and the two documented boot paths
// disagreed about the same studio. Resolution rules live in tools/seat-roster.mjs
// so their cases are testable without a rig.
// studio.json "rig": false says this box never attaches a rig, so the rig CLI is never run: no whoami, no rig
// list, no roster read. A box that serves one person can still have a rig CLI on its PATH, or OpenRig settings in
// its environment, that reach someone else's rig; asked anyway, its answers would put that rig's name in this
// box's log and roster. A roster this studio declares itself (surfaces.json chatSeats) still applies.
const NO_RIG = config.rig === false;
if (NO_RIG)
  console.log(
    '  rig     : never attached here (studio.json "rig": false), so the rig CLI is never run',
  );
// The nodes `rig ps --nodes` lists, or { error } when the rig couldn't be read (so a slow or missing rig isn't mistaken
// for a rig with no seats).
const rigNodes = (args) => {
  if (NO_RIG) return [];
  try {
    const raw = execFileSync("rig", ["ps", "--nodes", ...args, "--json"], {
      encoding: "utf8",
      timeout: 6000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const d = JSON.parse(raw);
    return Array.isArray(d) ? d : (d.nodes ?? []);
  } catch (e) {
    return {
      error: e.killed
        ? "timed out"
        : e.code === "ENOENT"
          ? "rig not found on PATH"
          : String(e.message || "failed")
              .split("\n")[0]
              .slice(0, 160),
    };
  }
};
const whoamiRig = (() => {
  if (NO_RIG) return null;
  try {
    const raw = execFileSync("rig", ["whoami", "--json"], {
      encoding: "utf8",
      timeout: 6000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(raw)?.identity?.rigName ?? null;
  } catch {
    return null;
  }
})();
// The studio's OWN surfaces.json may declare the roster, and that declaration
// wins entire — including an empty one, which means "this app ships without
// seats" rather than "nothing was declared".
const declaredSeats = (() => {
  const f = path.join(STUDIO, "surfaces.json");
  if (!fs.existsSync(f)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")).chatSeats;
  } catch {
    return undefined;
  }
})();
const { rig: seatRig, why: rigWhy } = NO_RIG
  ? { rig: null, why: 'a rig is never attached here (studio.json "rig": false)' }
  : resolveRig({
      declaredRig: config.rig,
      whoamiRig,
      // Any server hook means other people reach this Studio: it never guesses its rig.
      published: !!hooksPath({ config, env: process.env, studioDir: STUDIO }),
      rigsOnBox: []
        .concat(config.rig ? [] : rigNodes(["-A"]))
        .map((n) => n?.rigName)
        .filter(Boolean),
    });
const roster = resolveRoster({
  declared: declaredSeats,
  nodes: seatRig ? rigNodes(rigNodeArgs(seatRig)) : [],
  rig: seatRig,
  ambiguity: rigWhy,
});
let seatRoster = roster.seats;
let seatsFrom = roster.source;
// A rig's roster (none declared in surfaces.json) is kept current in the background (createRosterRefresh); if it couldn't
// be read at boot, the terminal is started anyway so the first good refresh makes seats attachable without a restart.
const rosterLive = Boolean(seatRig) && !Array.isArray(declaredSeats);
// A terminal endpoint is only advertised when one can actually be served.
// Advertising it without the binary would put clickable tiles in front of a
// user and fail on click; omitting it makes the shell say "listed, not
// attachable", which is a configuration gap the operator can act on.
const haveTtyd = (() => {
  try {
    execFileSync("ttyd", ["--version"], { stdio: "ignore", timeout: 4000 });
    return true;
  } catch {
    return false;
  }
})();
// The seat terminals' ttyd listens on a Unix socket in a fresh 0700 folder this Studio owns (tools/seat-terminal.mjs),
// never on a TCP port. The reserved seat port stays only as the manifest's "attachable" marker (chatLocalPort): the
// shell always reaches a seat through this origin's /chat.
const seat =
  (seatRoster.length || (rosterLive && roster.source === UNREACHABLE)) && haveTtyd
    ? createSeatSocket()
    : null;
if (seat && !seat.socket) console.error(`  warn    : seat terminals off: ${seat.reason}`);
// The folder goes with this Studio, however it ends (a refusal below included).
process.once("exit", () => seat?.close?.());
const seatSock = seat?.socket ?? null;
const seatPort = seatSock ? ports[2 + rail.providers.size] : null;
// Written again, from the new composition, when a live activation changes the apps.
// The composition last written: a roster refresh rewrites it with new seats, never the boot composition over a live
// activation's.
let lastComposition = rail;
const writeManifest = (source = lastComposition) => {
  lastComposition = source;
  return writeOverlayManifest({
    surfacesOut: source.surfacesOut,
    rows: source.rows,
    chatSeats: seatRoster,
    chatSeatsFrom: seatsFrom,
    ...(seatPort ? { chatLocalPort: seatPort } : {}),
    ...(config.welcome ? { welcome: config.welcome } : {}),
    ...(config.primaryRig ? { primaryRig: config.primaryRig } : {}),
  });
};
writeManifest();
if (rosterLive) {
  const readNodes = (args) =>
    new Promise((resolve) =>
      execFile(
        "rig",
        ["ps", "--nodes", ...args, "--json"],
        { encoding: "utf8", timeout: 30000, maxBuffer: 64 << 20 },
        (e, out) => {
          if (e)
            return resolve({
              error: e.killed
                ? "timed out"
                : String(e.message || "failed")
                    .split("\n")[0]
                    .slice(0, 160),
            });
          try {
            const d = JSON.parse(out);
            resolve(Array.isArray(d) ? d : (d.nodes ?? []));
          } catch {
            resolve({ error: "rig ps returned something that isn't JSON" });
          }
        },
      ),
    );
  const refresh = createRosterRefresh({
    rig: seatRig,
    read: readNodes,
    initial: seatRoster,
    log: (m) => console.log(m),
    write: (seats) => {
      seatRoster = seats;
      seatsFrom = "rig";
      writeManifest();
    },
  });
  setTimeout(refresh, roster.source === UNREACHABLE ? 5000 : 60000).unref();
  setInterval(refresh, 60000).unref();
}
// Report WHERE the roster came from, not just how many. "N live" was wrong on
// both counts: it called detached and exited nodes live, and it never said the
// set was the whole box rather than this studio's rig.
console.log(
  `  seats   : ${roster.note} [${roster.source}]${
    seatRoster.length && !seatPort
      ? " · NO ttyd on this box, so seats are listed but not attachable"
      : seatPort
        ? " · terminals through /chat (ttyd on a private Unix socket)"
        : ""
  }`,
);
if (roster.source !== DECLARED && !seatRig) console.log(`            ${rigWhy}`);

// ---- ports: assigned by the box, guarded before anything binds -------------
const sdkPort = ports[1];
const providerPorts = new Map();
for (const [i, pkg] of [...rail.providers].entries()) providerPorts.set(pkg, ports[2 + i]);

const guard = (p, label) =>
  new Promise((res) => {
    const s = net.createServer();
    s.once("error", (e) => {
      console.error(
        `studio: ${label} port ${p} is in use (${e.code}). Refusing to start half a studio.`,
      );
      process.exit(1);
    });
    s.once("listening", () => s.close(res));
    s.listen(p, "127.0.0.1");
  });
await guard(port, "public");
await guard(sdkPort, "runtime");
for (const [pkg, p] of providerPorts) await guard(p, pkg);

// ---- run the providers from their DECLARED specs ---------------------------
const home = os.homedir();
const exp = (p) =>
  typeof p === "string"
    ? path.resolve(STUDIO, p.startsWith("~") ? path.join(home, p.slice(1)) : p)
    : p;
// Root kinds are an OPEN vocabulary — `roots{}` in studio.json binds any kind
// by its own name. The four below are the ORIGINAL spellings, kept working.
//
// They used to be the entire set here and in the installer, so the format's
// promise ("roots declare KINDS; the install binds them") was false for every
// kind nobody had thought of. Spread LAST so an explicit roots{} entry wins
// rather than being shadowed by a legacy key.
const ROOTS = {
  project: exp(config.sliceRoot),
  media: (config.mediaRoots || []).map(exp),
  canvas: exp(config.canvasRoot),
  footage: exp(config.footageRoot),
  ...Object.fromEntries(
    Object.entries(config.roots ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(exp) : exp(v)]),
  ),
};
// FIRST RUN: seed the project with the PROVIDER'S OWN scaffolder.
//
// Without this a fresh studio has a sliceRoot that does not exist, and every
// project verb answers ENOENT — honest, but not a usable app. Seeding with a
// hand-written timeline.json would be worse: it would parse and then behave
// wrong, because the real schema carries history and slot state behind it.
//
// Only ever into an EMPTY or absent directory. A directory with contents and
// no timeline.json is somebody's data, and this refuses rather than seeding
// over it.
// A provider DECLARES how to seed the root it owns, in its own provider.json:
//
//   "seeds": { "root": "project", "marker": "timeline.json",
//              "entry": "video-new.mjs", "export": "scaffoldBundle" }
//
// This used to name providers/studio-video/video-new.mjs, scaffoldBundle and
// timeline.json literally, in the SDK's generic boot tool — the platform
// carrying one app's internals, so a studio that was not about video had a
// seeding path that could never fire. The provider is what knows how to make an
// empty root usable; the box only knows it is empty.
//
// Seeding at all is deliberate: a fresh studio whose root does not exist answers
// ENOENT on every project verb, which is honest and not a usable app. Seeding
// with a hand-written file would be worse — it would parse and then behave
// wrong, because the real schema carries history and slot state behind it.
async function seedDeclaredRoots(source = rail, roots = ROOTS) {
  const journal = path.join(STUDIO, ".studio-state", "seeded-roots.json");
  let initialized;
  try {
    initialized = JSON.parse(fs.readFileSync(journal, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("studio: initialization history could not be read; project folders were kept.");
      return false;
    }
    initialized = {};
  }
  if (!initialized || typeof initialized !== "object" || Array.isArray(initialized)) {
    console.error("studio: initialization history is unreadable; project folders were kept.");
    return false;
  }
  const remember = (root, pkg, seed) => {
    initialized[root] = { provider: pkg, marker: seed.marker ?? null, entry: seed.entry };
    fs.mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
    const temp = journal + "." + process.pid;
    fs.writeFileSync(temp, JSON.stringify(initialized, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, journal);
  };
  let any = false;
  for (const [pkg, spec] of source.providerRuns) {
    // ONE shape: top-level, as contract/app-manifest.md documents it. This read
    // `spec.run?.seeds ?? spec.seeds` — tolerant of two shapes, written without
    // checking which one the composer could actually produce. Neither branch
    // could fire, because the composer was dropping the field entirely. A
    // permissive reader hid a broken writer: had it accepted only the
    // documented shape, the gap would have surfaced the first time anyone
    // declared one instead of on a migration weeks later.
    const seed = spec.seeds;
    if (!seed?.root || !seed.entry) continue;
    const root = roots[seed.root];
    if (!root) continue;
    if (Object.hasOwn(initialized, root)) continue;
    const marker = seed.marker ? path.join(root, seed.marker) : root;
    if (fs.existsSync(marker)) {
      remember(root, pkg, seed);
      continue;
    }
    // Only ever into an EMPTY or absent directory. A directory with contents
    // and no marker is somebody's data, and this refuses rather than seeding
    // over it.
    if (fs.existsSync(root) && fs.readdirSync(root).length) {
      remember(root, pkg, seed);
      console.error(
        `studio: ${root} has contents but no ${seed.marker ?? "marker"} — not seeding over it.`,
      );
      continue;
    }
    const scaffolder = path.join(appsRoot, "providers", path.basename(pkg), seed.entry);
    if (!fs.existsSync(scaffolder)) {
      console.error(
        `studio: ${pkg} declares a seeder (${seed.entry}) that is not there — root ${seed.root} left empty.`,
      );
      continue;
    }
    try {
      // A missing marker after this attempt must not silently initialize again.
      remember(root, pkg, seed);
      if (fs.existsSync(root)) fs.rmdirSync(root);
      fs.mkdirSync(path.dirname(root), { recursive: true });
      const mod = await import(scaffolder);
      const fn = mod[seed.export ?? "default"];
      if (typeof fn !== "function") {
        console.error(
          `studio: ${pkg} seeder exports no ${seed.export ?? "default"} — root ${seed.root} left empty.`,
        );
        continue;
      }
      await fn(path.basename(root), { parent: path.dirname(root), idea: "studio project", port });
      console.log(`  seeded  : ${root} (declared by ${pkg})`);
      any = true;
    } catch (e) {
      console.error(`studio: ${pkg} could not seed ${seed.root} — ${e.message}`);
    }
  }
  return any;
}
await seedDeclaredRoots();

// ---- who may use this Studio ----------------------------------------------
// Loopback-only unless studio.json names server hooks (tools/server-hooks.mjs, contract/server-hooks.md).
// A named hook module that fails to load stops the boot: never a Studio that silently admits everyone.
let boundPort = port;
// The surface ids this box composes, the SDK's own Floor first (the runtime always serves it). Read from the rail each
// time, so a hook that asks later sees what is composed then.
const composedIds = () => [...new Set(["floor", ...rail.rows.map((row) => row.id)])];
let hooks;
try {
  hooks = await loadServerHooks({
    config,
    studioDir: STUDIO,
    ports: () => [boundPort],
    ctx: {
      env: process.env,
      config,
      studioDir: STUDIO,
      runtimeDir: RUNTIME_DIR,
      surfaces: composedIds,
      log: (m) => console.log(`  hooks   : ${String(m).slice(0, 300)}`),
      // A hook serving its own listener hands over the person it admitted; without one, nothing is served.
      route: (req, res, url, principal) =>
        isPrincipal(principal) ? route(req, res, url, principal) : refuseRequest(res, 403),
      upgradeRoute: (req, socket, head, principal) =>
        isPrincipal(principal)
          ? upgradeRoute(req, socket, head, principal)
          : refuseUpgrade(socket, "403 Forbidden"),
    },
  });
} catch (e) {
  console.error(`studio: ${e.message}`);
  console.error("Refusing to start rather than serve this Studio without the admission it names.");
  process.exit(1);
}
console.log(`  door    : ${hooks.describe}`);
// The box's Desktop, when it runs one (tools/desktop.mjs): a WebSocket to loopback websockify. Only behind an
// admission hook, which supplies the sign-in's expiry; a loopback-only Studio never offers it.
const desktop = hooks.local ? { target: null, describe: null } : readDesktopTarget(process.env);
if (hooks.local && (process.env.STUDIO_DESKTOP_SOCKET || process.env.STUDIO_DESKTOP_WS))
  console.log("  desktop off: only behind server hooks (contract/server-hooks.md)");
if (desktop.describe) console.log(`  ${desktop.describe}`);
const boxOrigins = originsFrom(process.env);
// The browser terminals. A loopback-only Studio serves /terminal/ and /team/ itself (tools/terminal.mjs). Behind an admission
// hook the same sockets, plus the agents view and its API, go through tools/hosted-terminals.mjs instead: Origin from
// SIGNIN_ORIGINS, closed at the principal's exp and when its sessions end, never for a files-only guest.
// A fresh local Studio works for its owner on first boot: when ttyd is installed and no shell socket is configured, the
// Studio starts its own shell listener (tools/start-terminal.mjs, supervised below) on a socket in a private folder it owns.
// A configured STUDIO_TERMINAL_SOCKET always wins, and a Studio behind server hooks never does this (its box starts its own).
const ttydUsable = (() => {
  const bin = process.env.STUDIO_TTYD_BIN;
  if (bin) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return path.isAbsolute(bin);
    } catch {
      return false;
    }
  }
  return haveTtyd;
})();
const autoShellSocket = (() => {
  if (!hooks.local || !ttydUsable || process.env.STUDIO_TERMINAL_SOCKET) return null;
  // A Unix socket path is at most ~100 bytes; a deep studio folder falls back to a per-studio folder in the temp dir.
  let dir = path.join(RUNTIME_DIR, "terminal");
  if (Buffer.byteLength(path.join(dir, "shell.sock")) > 100) {
    const id = createHash("sha256").update(STUDIO).digest("hex").slice(0, 12);
    dir = path.join(os.tmpdir(), `openrig-studio-${id}`);
  }
  const sock = path.join(dir, "shell.sock");
  if (Buffer.byteLength(sock) > 100) return null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    // Only a real folder this user owns: never a symlink or someone else's folder in a shared temp dir.
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) return null;
    fs.chmodSync(dir, 0o700);
  } catch {
    return null;
  }
  return sock;
})();
const terminalEnv = autoShellSocket
  ? { ...process.env, STUDIO_TERMINAL_SOCKET: autoShellSocket }
  : process.env;
// The origins whose pages may change this Studio and open its terminals besides its own address: STUDIO_ALLOWED_ORIGINS on a
// loopback-only Studio (tools/server-hooks.mjs), SIGNIN_ORIGINS behind hooks.
const pageOrigins = hooks.local ? hooks.allowedOrigins : boxOrigins;
const terminals = hooks.local
  ? createTerminals(terminalEnv, {
      shellMissing: !ttydUsable && !process.env.STUDIO_TERMINAL_SOCKET,
      allowedOrigins: pageOrigins,
    })
  : createHostedTerminals({ env: process.env, origins: boxOrigins });
if (
  hooks.local &&
  (process.env.STUDIO_AGENTS_WATCH_SOCKET || process.env.STUDIO_AGENTS_TYPE_SOCKET)
)
  console.log("  agents off: only behind server hooks (contract/server-hooks.md)");
for (const line of terminals.lines ?? []) console.log(`  ${line}`);
// Behind the door, a new key each boot that every Node child demands, so nothing but this process reaches
// the runtime or a provider on their own loopback ports (tools/child-key.mjs). Never logged.
const childKey = randomBytes(32).toString("hex");
const CHILD_GUARD = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "child-key.mjs"),
).href;
const childHeaders = () => ({ ...hooks.child.headers(), [KEY_HEADER]: childKey });
console.log("  key     : the runtime and providers answer only this process (a new key each boot)");

// Every child (the runtime, providers, companions, the seat terminal) runs under one supervisor: each exit is
// logged with its code and signal, a child that dies is restarted on the same command and port after a backoff,
// and one that can't stay up stops the whole studio so its own supervisor restarts it (tools/supervise.mjs).
const supervisor = createSupervisor();
// Refusal and unexpected exits stop only this startup's own children.
process.once("exit", () => supervisor.stop("SIGTERM"));
const spawnChild = (label, file, args, env, meta = {}) =>
  supervisor.start(
    label,
    process.execPath,
    ["--import", CHILD_GUARD, ...hooks.child.nodeArgs(), file, ...args],
    {
      stdio: "inherit",
      env: { ...process.env, ...hooks.child.env(), STUDIO_MODE: MODE, ...env, [KEY_ENV]: childKey },
    },
    meta,
  );
// Where a provider may generate state the runtime reads. A provider that
// declares {{state}} is saying "I generate the box's real observe-state", and
// the runtime is pointed here instead of at the SDK's shipped demo fixture.
// That is the seam that stops a real box rendering an invented rig under a
// live dot: the fiction is a fine SDK example and a lie on a deployed studio.
const STATE_DIR = path.join(RUNTIME_DIR, "state");
let stateClaimed = false;
// Providers are node; a seat terminal is not. Same child tracking so it dies
// with the studio rather than outliving it and holding a port.
const spawnRaw = (label, cmd, args, env, meta = {}, opts = {}) =>
  supervisor.start(
    label,
    cmd,
    args,
    { stdio: "inherit", ...opts, env: { ...process.env, ...env } },
    meta,
  );
// The owner's shell terminal, when this Studio started it (autoShellSocket above). The socket's folder is this Studio's own,
// so a socket left by a crash is cleared before every start, restarts included; start-terminal.mjs itself refuses an
// existing path, which is right for a socket someone configured.
if (autoShellSocket) {
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "start-terminal.mjs");
  spawnRaw(
    "terminal: shell",
    "/bin/sh",
    [
      "-c",
      'rm -f -- "$STUDIO_TERMINAL_SOCKET" && exec "$0" "$1" shell',
      process.execPath,
      launcher,
    ],
    { STUDIO_TERMINAL_SOCKET: autoShellSocket },
    { kind: "terminal" },
  );
  console.log("  terminal: the shell at /terminal/ (started by this Studio; ttyd)");
}
// {{port}} · {{port:<pkg>}} · {{root:<kind>}} · {{state}}; an array root repeats its flag.
const resolveArgs = (args, pkg) => {
  const out = [];
  for (const raw of args ?? []) {
    const m = String(raw).match(/^\{\{root:([a-z]+)\}\}$/);
    if (m) {
      const b = ROOTS[m[1]];
      if (b == null || (Array.isArray(b) && !b.length)) {
        out.pop();
        continue;
      }
      const vals = Array.isArray(b) ? b : [b];
      const flag = out[out.length - 1];
      out.push(vals[0]);
      for (const v of vals.slice(1)) out.push(flag, v);
      continue;
    }
    if (String(raw).includes("{{state}}")) stateClaimed = true;
    out.push(
      String(raw)
        .replace(/\{\{state\}\}/g, STATE_DIR)
        .replace(/\{\{port\}\}/g, String(providerPorts.get(pkg)))
        .replace(/\{\{port:([^}]+)\}\}/g, (_, p) => String(providerPorts.get(p) ?? "")),
    );
  }
  return out;
};
const serves = new Map(); // byte-route prefix -> port
const verbs = new Map(); // /api/ verb -> the provider that DECLARED it
// A provider is not always ONE process. Some verbs only ACCEPT work — the thing
// that performs it is a long-running companion (a renderer, a watcher). Those
// were declared in the manifest and never started, so cutdown's write verbs
// took a punch, wrote a real marker, and nothing ever rendered: the UI sat on
// "cutting…" forever. That is the accepted-but-unperformed failure, and it is
// worse than a 502 because every cheap check passes — the verb answers, the
// data changes on disk, and only the product is inert.
const missingCompanions = [];
const verbOwner = new Map(); // verb -> the provider package that claims it
const verbConflicts = [];
for (const [pkg, spec] of rail.providerRuns) {
  const dir = path.join(appsRoot, "providers", path.basename(pkg));
  const entry = spec.run?.entry && path.join(dir, spec.run.entry);
  if (!entry || !fs.existsSync(entry)) {
    console.error(`studio: ${pkg} has no runnable entry — its apps will 502`);
    continue;
  }
  const env = {};
  for (const [k, v] of Object.entries(spec.run.env ?? {})) env[k] = resolveArgs([v], pkg)[0];
  spawnChild(pkg, entry, resolveArgs(spec.run.args, pkg), env, {
    kind: "provider",
    port: providerPorts.get(pkg),
  });
  for (const s of spec.serves ?? []) serves.set(s, providerPorts.get(pkg));
  // Two providers claiming one verb used to be last-wins with no signal, so
  // which backend answered depended on compose order. That is how a generic
  // capability ends up owned by whichever app happened to be installed.
  for (const v of spec.verbs ?? []) {
    const prior = verbOwner.get(v);
    if (prior && prior !== pkg) verbConflicts.push(`${v} is declared by both ${prior} and ${pkg}`);
    verbOwner.set(v, pkg);
    verbs.set(v, providerPorts.get(pkg));
  }
  console.log(`  provider: ${pkg} on ${providerPorts.get(pkg)}`);
  // Declaring a companion IS declaring a requirement — an app that does not
  // need one does not list one. So a declared companion whose file is absent
  // is refused by name rather than skipped, for the same reason the rail
  // refuses when apps are declared and none composed: a studio that looks
  // healthy while silently swallowing work is the camouflage we keep paying for.
  for (const c of spec.run.companions ?? []) {
    const cEntry = c.entry && path.join(dir, c.entry);
    if (!cEntry || !fs.existsSync(cEntry)) {
      missingCompanions.push(
        `${pkg} declares companion "${c.label ?? c.entry}" (${c.entry}) — not found at ${cEntry}`,
      );
      continue;
    }
    const cEnv = {};
    for (const [k, v] of Object.entries(c.env ?? {})) cEnv[k] = resolveArgs([v], pkg)[0];
    spawnChild(`${pkg}:${c.label ?? c.entry}`, cEntry, resolveArgs(c.args, pkg), cEnv);
    console.log(`  companion: ${pkg} — ${c.label ?? c.entry}`);
  }
}
if (verbConflicts.length) {
  console.error(
    "studio: two providers claim the same verb, so which backend answers depends on install order:",
  );
  for (const c of verbConflicts) console.error(`  ${c}`);
  console.error("Refusing to start rather than route a verb by accident.");
  process.exit(1);
}
if (missingCompanions.length) {
  console.error(
    "studio: a declared companion process is missing, so verbs that enqueue for it would accept work nothing performs:",
  );
  for (const m of missingCompanions) console.error(`  ${m}`);
  console.error(
    "Refusing to start rather than serve a studio whose write verbs silently do nothing.",
  );
  process.exit(1);
}
const THEME =
  '{"background":"#121214","foreground":"rgba(255,255,255,0.9)","cursor":"rgba(255,255,255,0.85)","cursorAccent":"#121214","selectionBackground":"rgba(255,255,255,0.2)","black":"#121214","red":"#ff6b5a","green":"#7ea36f","yellow":"#d9c58a","blue":"#8b93ff","magenta":"#c79bd9","cyan":"#7fb8c9","white":"rgba(255,255,255,0.75)","brightBlack":"rgba(255,255,255,0.35)","brightRed":"#ff8a7a","brightGreen":"#94bd83","brightYellow":"#e8d7a3","brightBlue":"#a5abff","brightMagenta":"#d9b3ec","brightCyan":"#9cd0e0","brightWhite":"rgba(255,255,255,0.95)"}';
// The seat terminals: ttyd on its own Unix socket (seatSock above), reached only through this origin's /chat. -a is
// what passes ?arg=<seat> through to the attach script, so the seat name is the argument and there is no second id to
// keep in sync.
if (seatSock) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "seat-attach.sh");
  // -b /chat so the terminal lives under the SAME path the shell asks for,
  // through this origin. Nothing but this studio needs to be reachable, which
  // is what lets a proxy in front carry one rule instead of one per service.
  // A restart finds the old socket file in this Studio's own folder: it is removed first, and the new one is made
  // under umask 077 (and tightened to 0600 once ttyd has set its own mode).
  spawnRaw(
    "seat terminals",
    "/bin/sh",
    [
      "-c",
      'rm -f -- "$SEAT_SOCK"; umask 077; exec "$0" "$@"',
      "ttyd",
      "-W",
      "-a",
      "-i",
      seatSock,
      "-b",
      "/chat",
      // Errors only, and libwebsockets' plugin warnings left out (tools/ttyd-log.mjs): ttyd's default notices (a dozen
      // at start, one per page load) would fill the boot log.
      ...TTYD_QUIET,
      // Typography and palette ported rather than guessed. These were tuned
      // against real agent output over a week: 9px with this line height is what
      // fits an agent's wrapped output in the sidebar without it turning to
      // noise, and the palette is the house value ladder so a terminal beside an
      // app does not look like a foreign window pasted onto it.
      "-t",
      "fontSize=9",
      "-t",
      "lineHeight=1.35",
      "-t",
      "fontFamily=SF Mono, Menlo, ui-monospace, monospace",
      "-t",
      `theme=${THEME}`,
      "bash",
      script,
    ],
    {
      // The attach script authorizes against THIS FILE — the same composed
      // manifest the shell is served from, not a second query that ought to
      // agree with it. ?arg is caller-controlled, so the sidebar narrowing is a
      // suggestion and this is the boundary.
      OPENRIG_STUDIO_SEATS: path.join(rail.surfacesOut, "surfaces.json"),
      SEAT_SOCK: seatSock,
    },
    { kind: "terminal" },
    { stdio: ["inherit", "inherit", "pipe"], onStderr: (s) => forwardTtydLog(s) },
  );
  console.log("  terminal: seats attachable through /chat (ttyd on a Unix socket, this user only)");
}

// A provider that generates real state wins over the shipped demo fixture.
// Missing-file is safe here: the runtime reports an honest degraded envelope
// until the generator's first write, then its watcher picks the file up.
if (stateClaimed) fs.mkdirSync(STATE_DIR, { recursive: true });
const fixturesDir = stateClaimed
  ? STATE_DIR
  : config.fixtures
    ? exp(config.fixtures)
    : MODE === "demo"
      ? null
      : STATE_DIR;
if (fixturesDir === STATE_DIR) fs.mkdirSync(STATE_DIR, { recursive: true });
if (stateClaimed) console.log(`  state   : generated by a provider -> ${STATE_DIR}`);
// The runtime validates declared capture targets against these, so it has to
// know what this box bound. It resolved them here and kept them until now.
spawnChild(
  "runtime",
  RUNTIME,
  [
    "--port",
    String(sdkPort),
    "--surfaces",
    rail.surfacesOut,
    "--roots",
    JSON.stringify(ROOTS),
    "--mode",
    MODE,
    ...(fixturesDir ? ["--fixtures", fixturesDir] : []),
  ],
  {},
  { kind: "runtime", port: sdkPort },
);

// ---- one origin ------------------------------------------------------------
const proxy = (p) => (req, res) => {
  const up = http.request(
    {
      host: "127.0.0.1",
      port: p,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, ...childHeaders() },
    },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end('{"ok":false,"error":"provider unavailable"}');
  });
  req.pipe(up);
};
// The terminal frontend, with the clipboard shim spliced in.
//
// ttyd ships no OSC-52 handling, so a copy inside a terminal never reaches the
// OS clipboard — it dies in the terminal emulator. The shim wraps WebSocket
// before the bundle loads and writes decoded payloads out. It only works
// alongside the iframe's clipboard grants; both halves are required.
//
// Injected here rather than vendored: splicing it into an extracted frontend
// pins that copy to one ttyd version and has to be re-cut on every upgrade.
// This studio already owns the origin the terminal is served through, so it
// can splice on the way past and stay version-agnostic.
const CLIP_SHIM = (() => {
  try {
    return fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "clipboard-shim.html"),
      "utf8",
    );
  } catch {
    return "";
  }
})();
// The page comes from ttyd's socket, with the shim spliced in; only this origin may frame it (tools/seat-terminal.mjs).
const proxyTerminal = (req, res) =>
  proxyChatPage(req, res, { socketPath: seatSock, shim: CLIP_SHIM });
// RESERVED VERBS — the ones a provider may not capture.
//
// THE TEST IS WHOSE STATE THE VERB ANSWERS, and it is worth stating because I
// got it wrong in the other direction first. Asked whether the FILES verbs
// belonged here, I said yes, then retracted it: files are DIRECTORIES ON THE
// BOX, so in a real studio they SHOULD be served by something that knows about
// real directories, and reserving them would have forbidden the correct thing.
//
// These five answer the runtime's OWN state, which nothing else can hold:
//   /api/contract        the runtime describing itself
//   /api/factory/state   its fixture state
//   /api/events          its own change stream
//   /api/focus           focusRecord — in memory, in this process
//   /api/drive           driveOp     — in memory, in this process
//
// WHY focus AND drive ARE RESERVED: if a provider declares /api/focus and
// implements POST ONLY, the compositor (which routes a declared verb to its
// provider before the runtime) hands the provider BOTH methods, and GET
// /api/focus answers 404 while /api/contract goes on advertising focus.read,
// because the runtime declares the capability and cannot see that its route was
// taken. An agent doing feature detection is told the capability is there and
// then meets a 404. /api/drive has the same exposure.
//
// Reserving is the blunt fix and it is the right one TODAY: no provider can
// conformantly substitute state that lives in this process. The precise fix, if
// a real substitution case ever appears, is method-scoped routing — a provider
// declaring WHICH methods it implements and the rest falling through — and that
// wants its own gate rather than being invented here.
// Which verbs the runtime owns is declared once, in app/verbs.mjs, and the
// routing below asks isRuntimeOwned() rather than keeping its own list.
// A provider is not only its /api/ verbs — byte routes are prefixes, declared
// by the app. Leaving them out is why media listed and would not play.
// Routing /api/* to "the first provider" only works with one. With three, the
// video and cutdown verbs 404'd while the host provider answered — the apps
// were installed, running, and unreachable. Each app DECLARES its verbs; route
// by that. The single-provider fallback stays for a studio that has one.
// A verb ending in "/" is a PREFIX, exactly like a byte route in `serves`.
// Some verbs carry an id in the path (/api/export-status/<jobId>), so an
// exact-match table can never route them and the app 404s on a verb it
// correctly declared. Reusing the trailing-slash rule the manifest already
// uses for byte routes means no second syntax to learn and nothing new to
// declare — "/api/export-status/" matches its children, "/api/health" does not.
// Both read the routing tables per request: a live activation changes them.
const soleProvider = () => (providerPorts.size === 1 ? [...providerPorts.values()][0] : null);
const routeVerb = (pathname) => {
  const exact = verbs.get(pathname);
  if (exact) return exact;
  for (const [prefix, port] of verbs)
    if (prefix.endsWith("/") && pathname.startsWith(prefix)) return port;
  return null;
};

// Apps and providers installed, updated or removed while this Studio runs take effect without a restart
// (tools/runtime-extensions.mjs). New providers start through spawnChild like every other (supervised, with the child key
// and the hooks' child settings), and a replaced one leaves supervision for good.
const extensionRefresh = refreshExtensions({
  studio: STUDIO,
  rail,
  initial: extensionBaseline,
  ports: providerPorts,
  serves,
  verbs,
  start: spawnChild,
  retire: (label) => supervisor.remove(label),
  seed: seedDeclaredRoots,
  writeManifest,
});

const healthHosts = allowedHostsFrom(process.env);
// Every request but the health check goes through admission first; route() runs only for an admitted
// principal (or, for /healthz, none).
// No single request may stop the Studio: a request line that isn't a URL (`GET //x:99999/a`) is answered 400 or its socket
// closed, and an admission (or the route it admits to) that throws or rejects is answered 503, as project apps do
// (tools/project-app-server.mjs). A hook that calls next() without a principal object admits no one: 403.
const studioServer = http
  .createServer((req, res) => {
    const url = parseUrl(req);
    if (!url) return refuseRequest(res, 400);
    if (isHealth(req, url)) return guarded(() => route(req, res, url, null), res);
    return guarded(
      () =>
        hooks.admission.http(req, res, (principal) =>
          isPrincipal(principal) ? route(req, res, url, principal) : refuseRequest(res, 403),
        ),
      res,
    );
  })
  .listen(port, "127.0.0.1", () => {
    boundPort = studioServer.address().port;
    console.log(
      `studio: http://127.0.0.1:${boundPort}/  (runtime ${sdkPort}${serves.size ? ` · ${serves.size} byte route(s)` : ""})`,
    );
  });

function route(req, res, url, principal) {
  // The box's own health: every child it runs, whether it's up and whether its port answers. 503 when any isn't.
  // Anyone may ask. Which children, their pids and ports go only to this computer on a loopback-only Studio, or, behind
  // server hooks, to anyone when the box opts in with STUDIO_HEALTH_DETAIL=1 (tools/server-hooks.mjs, healthDetailAllowed).
  // Everyone else gets { ok }.
  if (isHealth(req, url)) {
    return Promise.all([
      Promise.all(
        supervisor.health().map(async (c) => ({ ...c, listening: await listening(c.port) })),
      ),
      healthDetailAllowed(req, { hooks, ports: () => [boundPort], allowedHosts: healthHosts }),
    ]).then(([children, detail]) => {
      const ok = children.every((c) => c.up && c.listening !== false);
      // A hook hears each answer once it has gone out (a heartbeat while healthy, say), always with every child. The
      // health check itself never waits on it.
      res.once("finish", () => notifyHealth(hooks, { ok, children, method: req.method }));
      res.writeHead(ok ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        req.method === "HEAD" ? undefined : JSON.stringify(detail ? { ok, children } : { ok }),
      );
    });
  }
  if (url.pathname === "/api/studio/place") {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { allow: "GET, HEAD" });
      return res.end();
    }
    const state = terminals.place();
    const filesOnly = principal?.workspace === "files";
    // A hook may add the environment's name and account page; it never changes who the person is.
    const extra = (hooks.place && principal ? hooks.place(principal) : null) ?? {};
    // The Desktop only while it answers: a socket that's private and ours, or a TCP port something accepts on now
    // (tools/desktop.mjs, desktopAnswering: one bounded connect, its answer kept briefly).
    const wantDesktop = Boolean(principal && !filesOnly && desktop.target);
    return (wantDesktop ? desktopAnswering(desktop.target) : Promise.resolve(false)).then(
      (desktopOn) => {
        const body = JSON.stringify({
          profile: hooks.local ? "local" : "hosted",
          mode: MODE,
          workspace: principal?.workspace ?? null,
          access: principal?.access ?? null,
          // A hook's label wins, and null from it means "this box has no name to show", never the Studio's own.
          label:
            typeof extra.label === "string" || extra.label === null
              ? extra.label
              : config.name || "This Studio",
          account: typeof extra.account === "string" ? extra.account : null,
          desktop: desktopOn ? DESKTOP_PATH : null,
          terminal: filesOnly ? null : state.terminal.path,
          team: filesOnly ? null : state.team.path,
          agents: {
            watch: filesOnly ? null : (state.agentsWatch?.path ?? null),
            type: filesOnly ? null : (state.agentsType?.path ?? null),
          },
          terminals: filesOnly ? null : state,
        });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : body);
      },
    );
  }
  if (terminals.request(req, res, url, principal)) return;
  if (url.pathname.startsWith("/vendor/")) {
    const file = vendorFile(rail.vendorOut, url.pathname.slice("/vendor/".length));
    if (file) {
      const headers = {
        "content-type": file.type,
        "cache-control": VENDOR_CACHE,
        etag: file.etag,
        "x-content-type-options": "nosniff",
      };
      if (notModified(req.headers["if-none-match"], file.etag)) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file.file).pipe(res);
    }
    res.writeHead(404);
    return res.end();
  }
  // Seat terminals ride this origin like any other byte route. They are a
  // websocket upgrade as well as HTTP, handled below.
  if (seatSock && isChatPath(url.pathname)) return proxyTerminal(req, res);
  for (const [prefix, p] of serves) if (url.pathname.startsWith(prefix)) return proxy(p)(req, res);
  // PREFIX-AWARE, not Set.has(). An exact-only check cannot express a
  // parameterized runtime verb, and the verb vocabulary this shares with providers
  // says a trailing `/` is a prefix — so an exact check would let the next
  // /api/thing/<id> route fall through to a sole provider that never declared it.
  if (url.pathname.startsWith("/api/") && !isRuntimeOwned(url.pathname)) {
    const p = routeVerb(url.pathname) ?? soleProvider();
    if (p) return proxy(p)(req, res);
  }
  if (
    hooks.transformShell &&
    url.pathname === "/" &&
    (req.method === "GET" || req.method === "HEAD")
  )
    return shellThrough(req, res, principal);
  return proxy(sdkPort)(req, res);
}

// The request's URL, or null when the request line isn't one (a port out of range, say).
function parseUrl(req) {
  try {
    return new URL(req.url, "http://x");
  } catch {
    return null;
  }
}
function isPrincipal(p) {
  return p !== null && typeof p === "object";
}
function refuseRequest(res, code) {
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { "cache-control": "no-store", "content-length": 0 });
  res.end();
}
// Runs one request's handling so that a throw or a rejection answers 503 (or ends a response already begun) instead of
// stopping the Studio.
function guarded(fn, res) {
  Promise.resolve()
    .then(fn)
    .catch(() => refuseRequest(res, 503));
}

// The shell page, read whole from the runtime (it is small and served no-store) so a hook can add to it
// for this person: an environment's name, account links, its own navigation.
function shellThrough(req, res, principal) {
  const headers = { ...req.headers, ...childHeaders() };
  delete headers["accept-encoding"];
  const up = http.request(
    { host: "127.0.0.1", port: sdkPort, path: req.url, method: "GET", headers },
    (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        let body = Buffer.concat(chunks);
        const h = { ...r.headers, "cache-control": "no-store" };
        delete h["content-length"];
        delete h["transfer-encoding"];
        delete h.etag;
        if (r.statusCode === 200 && /^text\/html/.test(h["content-type"] || "")) {
          // served: the byte-route prefixes a provider answers on this box now, so a hook can tell what it may point at.
          const out = hooks.transformShell(body.toString("utf8"), {
            principal,
            surfaces: composedIds(),
            served: [...serves.keys()],
          });
          if (typeof out === "string") body = Buffer.from(out);
        }
        h["content-length"] = body.length;
        res.writeHead(r.statusCode || 502, h);
        res.end(req.method === "HEAD" ? undefined : body);
      });
    },
  );
  up.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end('{"ok":false,"error":"provider unavailable"}');
  });
  up.end();
}

// A terminal is a WEBSOCKET, and an HTTP-only proxy in front of one gives you
// a page that loads and a terminal that never connects — renders-but-does-not-
// work, wearing a 200. Upgrades have to be tunnelled explicitly: Node routes
// them to 'upgrade', not to the request handler, so the route above would
// never see them.
// Upgrades go through the same admission as requests.
studioServer.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  if (!parseUrl(req)) return refuseUpgrade(socket, "400 Bad Request");
  Promise.resolve()
    .then(() =>
      hooks.admission.upgrade(req, socket, head, (principal) =>
        isPrincipal(principal)
          ? upgradeRoute(req, socket, head, principal)
          : refuseUpgrade(socket, "403 Forbidden"),
      ),
    )
    .catch(() => refuseUpgrade(socket, "503 Service Unavailable"));
});
function upgradeRoute(req, socket, head, principal) {
  if (principal?.workspace === "files") return refuseUpgrade(socket);
  const url = parseUrl(req);
  if (!url) return refuseUpgrade(socket, "400 Bad Request");
  // A refused desktop upgrade leaves one value-free line: the time and the tunnel's own fixed reason, never a token or an
  // address.
  if (desktop.target && principal && url.pathname === DESKTOP_PATH)
    return upgradeDesktop(req, socket, head, {
      target: desktop.target,
      origins: boxOrigins,
      exp: principal.exp,
      sessions: principal.sessions,
      session: principal.session,
      onClose: (why) => console.log(`desktop: closed at ${new Date().toISOString()} (${why})`),
      onRefuse: (why) =>
        console.log(
          `desktop: refused at ${new Date().toISOString()} (${why === "not this box's Studio" ? "origin" : why})`,
        ),
    });
  if (terminals.upgrade(req, socket, head, principal)) return;
  if (!seatSock || !isChatPath(url.pathname)) return socket.destroy();
  // A seat's terminal: closed at the principal's exp and when its sessions end, when it carries them; otherwise this
  // Studio's own Origin only (tools/seat-terminal.mjs). ttyd's socket is tightened to 0600 before it is checked.
  seat.tighten();
  return upgradeChat(req, socket, head, {
    socketPath: seatSock,
    principal,
    origins: pageOrigins,
    log: (line) => console.log(line),
  });
}

for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    extensionRefresh.close();
    terminals.close();
    try {
      hooks.close();
    } catch {
      /* A hook's own shutdown must not keep the Studio's children running. */
    }
    supervisor.stop(sig);
    process.exit(0);
  });
