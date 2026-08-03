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
// studio.json: { apps: [], appsRoot, port, doors?, and one binding per root KIND }

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { composeRail, writeOverlayManifest } from "./compose-rail.mjs";

const STUDIO = path.resolve(process.env.OPENRIG_STUDIO_DIR || process.cwd());
const cfgPath = path.join(STUDIO, "studio.json");
if (!fs.existsSync(cfgPath)) {
  console.error(`studio: no studio.json in ${STUDIO}. Scaffold one with create-studio.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const port = Number(arg("--port", String(config.port ?? 8890)));
const appsRoot = (config.appsRoot ?? path.join(STUDIO, "apps")).replace(/^~/, os.homedir());
const RUNTIME = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "app", "serve-studio.mjs");

// ---- compose ---------------------------------------------------------------
const rail = composeRail({
  appsRoot, enabled: config.apps ?? [], doors: config.doors ?? [],
  runtimeDir: path.join(STUDIO, ".runtime"), studioRoot: STUDIO,
  log: (m) => console.log(`  app     : ${m}`),
});
for (const m of rail.missing) console.error(`  MISSING : ${m}`);

// A door is not an app: declared-but-absent is a BROKEN INSTALL, not an empty
// studio, and it must not come up looking healthy.
const declared = (config.apps ?? []).length;
const composed = rail.rows.filter((r) => !(config.doors ?? []).some((d) => d.id === r.id)).length;
if (declared && !composed) {
  console.error(`studio: ${declared} app(s) enabled and NONE composed. Refusing to start and look healthy.`);
  process.exit(1);
}
// ---- the seat roster: derived, never authored ------------------------------
// The sidebar is the point of this shell — a human and the agents that wrote
// the app, on one screen. Its roster is RUNTIME state, so it is derived from
// the live rig at boot and never written back into a source-controlled file.
//
// Deriving it is also what keeps the roster and the attach allowlist from
// disagreeing: seat-attach.sh checks the same live rig, so a tile can never
// exist for a seat that refuses to attach. Two places deriving one property
// is the drift shape, and the studio this was ported from named that as its
// own outstanding fix.
//
// No rig is a normal state, not an error: the roster is simply absent and the
// shell says so. A studio need not be attached to a rig; it must know whether
// it is.
//
// FLEET-WIDE (-A) is required, not optional. Outside a managed session the CLI
// has no current rig to default to and exits non-zero with "no target" — so a
// bare invocation fails on precisely the boxes this runs on, while working on
// a developer machine that happens to be inside a session. Found by deploying
// to a box that was not the one it was written on.
function liveSeats() {
  try {
    const raw = execFileSync("rig", ["ps", "--nodes", "-A", "--json"], { encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "ignore"] });
    const d = JSON.parse(raw);
    const nodes = Array.isArray(d) ? d : d.nodes ?? [];
    return nodes
      .map((n) => ({ seat: n.canonicalSessionName || `${n.logicalId}@${n.rigName}`, name: n.logicalId || n.canonicalSessionName }))
      .filter((s) => s.seat && !s.seat.includes("undefined"));
  } catch { return []; }
}
const seatRoster = liveSeats();
// A terminal endpoint is only advertised when one can actually be served.
// Advertising it without the binary would put clickable tiles in front of a
// user and fail on click; omitting it makes the shell say "listed, not
// attachable", which is a configuration gap the operator can act on.
const haveTtyd = (() => {
  try { execFileSync("ttyd", ["--version"], { stdio: "ignore", timeout: 4000 }); return true; }
  catch { return false; }
})();
// Allocated AFTER the providers so it cannot collide with them: the public
// port is n, the runtime n+1, providers from n+2, and the seat terminal takes
// the next one after those.
const seatPort = seatRoster.length && haveTtyd ? port + 2 + rail.providers.size : null;
writeOverlayManifest({
  surfacesOut: rail.surfacesOut,
  rows: rail.rows,
  chatSeats: seatRoster,
  ...(seatPort ? { chatLocalPort: seatPort } : {}),
  ...(config.welcome ? { welcome: config.welcome } : {}),
});
if (seatRoster.length) {
  console.log(`  seats   : ${seatRoster.length} live${seatPort ? ` · terminals on ${seatPort}` : " · NO ttyd on this box, so seats are listed but not attachable"}`);
} else {
  console.log("  seats   : none — no rig on this box, so the agent sidebar will say so rather than show a fixture");
}

// ---- ports: assigned by the box, guarded before anything binds -------------
const sdkPort = port + 1;
const providerPorts = new Map();
let next = port + 2;
for (const pkg of rail.providers) providerPorts.set(pkg, next++);

const guard = (p, label) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", (e) => {
    console.error(`studio: ${label} port ${p} is in use (${e.code}). Refusing to start half a studio.`);
    process.exit(1);
  });
  s.once("listening", () => s.close(res));
  s.listen(p, "127.0.0.1");
});
await guard(port, "public"); await guard(sdkPort, "runtime");
for (const [pkg, p] of providerPorts) await guard(p, pkg);

// ---- run the providers from their DECLARED specs ---------------------------
const home = os.homedir();
const exp = (p) => (typeof p === "string" && p.startsWith("~") ? path.join(home, p.slice(1)) : p);
const ROOTS = {
  project: exp(config.sliceRoot), media: (config.mediaRoots || []).map(exp),
  canvas: exp(config.canvasRoot), footage: exp(config.footageRoot),
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
async function seedProject() {
  const root = ROOTS.project;
  if (!root || fs.existsSync(path.join(root, "timeline.json"))) return;
  if (fs.existsSync(root) && fs.readdirSync(root).length) {
    console.error(`studio: ${root} has contents but no timeline.json — not seeding over it.`);
    return;
  }
  const scaffolder = path.join(appsRoot, "providers", "studio-video", "video-new.mjs");
  if (!fs.existsSync(scaffolder)) return;
  try {
    if (fs.existsSync(root)) fs.rmdirSync(root);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    const { scaffoldBundle } = await import(scaffolder);
    scaffoldBundle(path.basename(root), { parent: path.dirname(root), idea: "studio project", port });
    console.log(`  seeded  : ${root}`);
  } catch (e) {
    console.error(`studio: could not seed the project — ${e.message}`);
  }
}
await seedProject();

const children = [];
const spawnChild = (label, file, args, env) => {
  const c = spawn(process.execPath, [file, ...args], { stdio: "inherit", env: { ...process.env, ...env } });
  c.on("exit", (code) => { if (code) console.error(`studio: ${label} exited ${code}`); });
  children.push(c);
};
// Where a provider may generate state the runtime reads. A provider that
// declares {{state}} is saying "I generate the box's real observe-state", and
// the runtime is pointed here instead of at the SDK's shipped demo fixture.
// That is the seam that stops a real box rendering an invented rig under a
// live dot: the fiction is a fine SDK example and a lie on a deployed studio.
const STATE_DIR = path.join(path.dirname(rail.surfacesOut), "state");
let stateClaimed = false;
// Providers are node; a seat terminal is not. Same child tracking so it dies
// with the studio rather than outliving it and holding a port.
const spawnRaw = (label, cmd, args) => {
  const c = spawn(cmd, args, { stdio: "inherit" });
  c.on("error", (e) => console.error(`studio: ${label} could not start — ${e.message}`));
  c.on("exit", (code) => { if (code) console.error(`studio: ${label} exited ${code}`); });
  children.push(c);
};
// {{port}} · {{port:<pkg>}} · {{root:<kind>}} · {{state}}; an array root repeats its flag.
const resolveArgs = (args, pkg) => {
  const out = [];
  for (const raw of args ?? []) {
    const m = String(raw).match(/^\{\{root:([a-z]+)\}\}$/);
    if (m) {
      const b = ROOTS[m[1]];
      if (b == null || (Array.isArray(b) && !b.length)) { out.pop(); continue; }
      const vals = Array.isArray(b) ? b : [b];
      const flag = out[out.length - 1];
      out.push(vals[0]);
      for (const v of vals.slice(1)) out.push(flag, v);
      continue;
    }
    if (String(raw).includes("{{state}}")) stateClaimed = true;
    out.push(String(raw)
      .replace(/\{\{state\}\}/g, STATE_DIR)
      .replace(/\{\{port\}\}/g, String(providerPorts.get(pkg)))
      .replace(/\{\{port:([^}]+)\}\}/g, (_, p) => String(providerPorts.get(p) ?? "")));
  }
  return out;
};
const serves = new Map();   // byte-route prefix -> port
const verbs = new Map();    // /api/ verb -> the provider that DECLARED it
// A provider is not always ONE process. Some verbs only ACCEPT work — the thing
// that performs it is a long-running companion (a renderer, a watcher). Those
// were declared in the manifest and never started, so cutdown's write verbs
// took a punch, wrote a real marker, and nothing ever rendered: the UI sat on
// "cutting…" forever. That is the accepted-but-unperformed failure, and it is
// worse than a 502 because every cheap check passes — the verb answers, the
// data changes on disk, and only the product is inert.
const missingCompanions = [];
const verbOwner = new Map();     // verb -> the provider package that claims it
const verbConflicts = [];
for (const [pkg, spec] of rail.providerRuns) {
  const dir = path.join(appsRoot, "providers", path.basename(pkg));
  const entry = spec.run?.entry && path.join(dir, spec.run.entry);
  if (!entry || !fs.existsSync(entry)) { console.error(`studio: ${pkg} has no runnable entry — its apps will 502`); continue; }
  const env = {};
  for (const [k, v] of Object.entries(spec.run.env ?? {})) env[k] = resolveArgs([v], pkg)[0];
  spawnChild(pkg, entry, resolveArgs(spec.run.args, pkg), env);
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
      missingCompanions.push(`${pkg} declares companion "${c.label ?? c.entry}" (${c.entry}) — not found at ${cEntry}`);
      continue;
    }
    const cEnv = {};
    for (const [k, v] of Object.entries(c.env ?? {})) cEnv[k] = resolveArgs([v], pkg)[0];
    spawnChild(`${pkg}:${c.label ?? c.entry}`, cEntry, resolveArgs(c.args, pkg), cEnv);
    console.log(`  companion: ${pkg} — ${c.label ?? c.entry}`);
  }
}
if (verbConflicts.length) {
  console.error("studio: two providers claim the same verb, so which backend answers depends on install order:");
  for (const c of verbConflicts) console.error(`  ${c}`);
  console.error("Refusing to start rather than route a verb by accident.");
  process.exit(1);
}
if (missingCompanions.length) {
  console.error("studio: a declared companion process is missing, so verbs that enqueue for it would accept work nothing performs:");
  for (const m of missingCompanions) console.error(`  ${m}`);
  console.error("Refusing to start rather than serve a studio whose write verbs silently do nothing.");
  process.exit(1);
}
// The seat terminals. Loopback by IP rather than by interface name, which is
// the portable form — reaching a studio remotely stays a separate, deliberate
// act. -a is what passes ?arg=<seat> through to the attach script, so the seat
// name is the argument and there is no second id to keep in sync.
if (seatPort) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "seat-attach.sh");
  // -b /chat so the terminal lives under the SAME path the shell asks for,
  // through this origin. Nothing but this studio needs to be reachable, which
  // is what lets a proxy in front carry one rule instead of one per service.
  spawnRaw("seat terminals", "ttyd", [
    "-W", "-a", "-p", String(seatPort), "-i", "127.0.0.1", "-b", "/chat",
    "-t", "fontSize=10", "-t", "lineHeight=1.35",
    "bash", script,
  ]);
  console.log(`  terminal: seats attachable on ${seatPort}`);
}

// A provider that generates real state wins over the shipped demo fixture.
// Missing-file is safe here: the runtime reports an honest degraded envelope
// until the generator's first write, then its watcher picks the file up.
if (stateClaimed) fs.mkdirSync(STATE_DIR, { recursive: true });
const fixturesDir = stateClaimed ? STATE_DIR : (config.fixtures ? exp(config.fixtures) : null);
if (stateClaimed) console.log(`  state   : generated by a provider -> ${STATE_DIR}`);
spawnChild("runtime", RUNTIME, ["--port", String(sdkPort), "--surfaces", rail.surfacesOut,
  ...(fixturesDir ? ["--fixtures", fixturesDir] : [])]);

// ---- one origin ------------------------------------------------------------
const proxy = (p) => (req, res) => {
  const up = http.request({ host: "127.0.0.1", port: p, path: req.url, method: req.method, headers: req.headers },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(502, { "content-type": "application/json" }); res.end('{"ok":false,"error":"provider unavailable"}'); });
  req.pipe(up);
};
const SDK_OWNED = new Set(["/api/contract", "/api/factory/state", "/api/events"]);
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
const soleProvider = providerPorts.size === 1 ? [...providerPorts.values()][0] : null;
const verbPrefixes = [...verbs.entries()].filter(([v]) => v.endsWith("/"));
const routeVerb = (pathname) => {
  const exact = verbs.get(pathname);
  if (exact) return exact;
  for (const [prefix, port] of verbPrefixes) if (pathname.startsWith(prefix)) return port;
  return null;
};

const studioServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/vendor/")) {
    const f = path.join(rail.vendorOut, url.pathname.slice("/vendor/".length));
    if (f.startsWith(rail.vendorOut) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { "cache-control": "public, max-age=31536000, immutable" });
      return fs.createReadStream(f).pipe(res);
    }
    res.writeHead(404); return res.end();
  }
  // Seat terminals ride this origin like any other byte route. They are a
  // websocket upgrade as well as HTTP, handled below.
  if (seatPort && (url.pathname === "/chat" || url.pathname.startsWith("/chat/"))) return proxy(seatPort)(req, res);
  for (const [prefix, p] of serves) if (url.pathname.startsWith(prefix)) return proxy(p)(req, res);
  if (url.pathname.startsWith("/api/") && !SDK_OWNED.has(url.pathname)) {
    const p = routeVerb(url.pathname) ?? soleProvider;
    if (p) return proxy(p)(req, res);
  }
  return proxy(sdkPort)(req, res);
}).listen(port, "127.0.0.1", () => {
  console.log(`studio: http://127.0.0.1:${port}/  (runtime ${sdkPort}${serves.size ? ` · ${serves.size} byte route(s)` : ""})`);
});

// A terminal is a WEBSOCKET, and an HTTP-only proxy in front of one gives you
// a page that loads and a terminal that never connects — renders-but-does-not-
// work, wearing a 200. Upgrades have to be tunnelled explicitly: Node routes
// them to 'upgrade', not to the request handler, so the route above would
// never see them.
studioServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (!seatPort || !(url.pathname === "/chat" || url.pathname.startsWith("/chat/"))) return socket.destroy();
  const up = http.request({ host: "127.0.0.1", port: seatPort, path: req.url, method: req.method,
    headers: req.headers });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n` +
      Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    if (upHead?.length) socket.unshift(upHead);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
  });
  up.on("error", () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { children.forEach((c) => c.kill(sig)); process.exit(0); });
