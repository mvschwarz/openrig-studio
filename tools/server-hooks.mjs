// Server hooks: the one seam through which a deployment decides who may use this Studio.
//
// Without hooks, a Studio answers only this computer: every request and WebSocket upgrade must name a
// loopback Host (127.0.0.1, localhost or [::1]) on the Studio's own port. A web page the owner visits can
// point its own name at 127.0.0.1 (DNS rebinding) and reach loopback ports, but it still sends its own
// Host, so it is refused.
//
// The Host alone doesn't stop a page on another site from sending the owner's browser to 127.0.0.1 with a
// form or a fetch: that request carries a loopback Host. So every change (any method but GET, HEAD and
// OPTIONS) and every upgrade must also come from this Studio's own pages: an Origin, when the browser sends
// one, must be this Studio's own address or one listed in STUDIO_ALLOWED_ORIGINS, and Sec-Fetch-Site must
// not say another site sent it. Local tools (curl, scripts) send neither header, so they still work.
//
// A deployment that admits people another way (a sign-in in front of a hosted box) names a module in
// studio.json "serverHooks" (or STUDIO_SERVER_HOOKS). That module replaces the loopback gate entirely;
// the two never run together. The contract is contract/server-hooks.md.

import path from "node:path";
import { pathToFileURL } from "node:url";

// The box's own health check is never put behind a sign-in: a supervisor must be able to ask it.
export const isHealth = (req, url) =>
  url.pathname === "/healthz" && (req.method === "GET" || req.method === "HEAD");

// The person a request was admitted as. `workspace` is what they may see ("full", or "files" for a
// files-only guest); `access` is their role. `exp`, `session` and `sessions` let long-lived tunnels
// close when that person's sign-in ends (see contract/server-hooks.md).
export const LOCAL_OWNER = Object.freeze({ workspace: "full", access: "owner" });

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOST_SHAPE = /^[a-z0-9.\-[\]:]{1,300}$/;

// Extra Host values a loopback Studio may answer to, for a box reached through an SSH forward on another
// local port or a proxy that keeps its public Host. Comma-separated, exactly as the browser sends them.
export function allowedHostsFrom(env = process.env) {
  return String(env.STUDIO_ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x && HOST_SHAPE.test(x));
}

export function isLoopbackHost(req, ports, allowedHosts = []) {
  const h = req?.headers?.host;
  if (typeof h !== "string" || !h || h.length > 300) return false;
  if (allowedHosts.includes(h.toLowerCase())) return true;
  let u;
  try {
    u = new URL(`http://${h}`);
  } catch {
    return false;
  }
  return (
    LOOPBACK_NAMES.has(u.hostname) &&
    !u.username &&
    !u.password &&
    u.pathname === "/" &&
    ports().includes(Number(u.port || 80))
  );
}

const NOT_HERE =
  "This Studio answers only on this computer's own address (127.0.0.1 or localhost).\n";
const NOT_FROM_HERE =
  "This Studio takes changes only from its own pages. Another site's page can't change it, and an app hosted elsewhere needs its origin in STUDIO_ALLOWED_ORIGINS.\n";

// Extra origins whose pages may change a loopback Studio, for a host that serves the Studio's pages from its
// own address and forwards the browser's Origin (an app that embeds a Studio behind its own UI sets this to
// that UI's origin). Comma-separated exact origins (scheme, host and port, no path); anything else is dropped.
export function allowedOriginsFrom(env = process.env) {
  const out = new Set();
  for (const raw of String(env.STUDIO_ALLOWED_ORIGINS || "").split(",")) {
    const v = raw.trim().replace(/\/$/, "");
    if (!v) continue;
    try {
      const u = new URL(v);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === v.toLowerCase())
        out.add(u.origin);
    } catch {
      /* not an origin: dropped */
    }
  }
  return out;
}

// Whether a request's Origin is this Studio's own address (the Host it was admitted on, over http or https)
// or one of `allowedOrigins`. "null" (a sandboxed frame, a file, a redirect from another site) is never
// either. A missing Origin is not an origin at all: callers decide what that means.
export function isOwnOrigin(req, allowedOrigins = new Set()) {
  const o = req?.headers?.origin,
    h = req?.headers?.host;
  if (typeof o !== "string" || !o || o === "null") return false;
  const origin = o.toLowerCase();
  if (allowedOrigins.has(origin)) return true;
  if (typeof h !== "string" || !h) return false;
  const host = h.toLowerCase();
  return origin === `http://${host}` || origin === `https://${host}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Sec-Fetch-Site values that mean "not this origin's own page". On a loopback Studio "same-site" is no
// better than "cross-site": every other port on 127.0.0.1 (any local dev server) is the same site, so it
// is treated the same way.
const OTHER_SITE = new Set(["cross-site", "same-site"]);

// Whether a request or upgrade came from this Studio's own pages, for a change or a WebSocket. With an
// Origin: it must be one of `allowedOrigins` (trusted however it was sent), or this Studio's own address
// sent as same-origin. Without one: allowed unless Sec-Fetch-Site says another site sent it, so local
// tools that send neither header keep working.
export function fromOwnPages(req, allowedOrigins = new Set()) {
  const origin = req?.headers?.origin;
  const site = String(req?.headers?.["sec-fetch-site"] ?? "").toLowerCase();
  if (typeof origin === "string" && origin) {
    if (origin !== "null" && allowedOrigins.has(origin.toLowerCase())) return true;
    return isOwnOrigin(req) && !OTHER_SITE.has(site);
  }
  return !OTHER_SITE.has(site);
}

// The rule for one request: reads (GET, HEAD, OPTIONS) need only the Host; everything else must also come
// from this Studio's own pages.
export function writeAllowed(req, allowedOrigins = new Set()) {
  if (SAFE_METHODS.has(String(req?.method || "GET").toUpperCase())) return true;
  return fromOwnPages(req, allowedOrigins);
}

// The default admission. `ports` is a function so the check follows the port the server actually bound
// (studio.json may ask for port 0).
export function loopbackAdmission({ ports, allowedHosts = [], allowedOrigins = new Set() }) {
  const extra = [
    allowedHosts.length ? `${allowedHosts.length} allowed host(s)` : "",
    allowedOrigins.size ? `${allowedOrigins.size} allowed origin(s)` : "",
  ].filter(Boolean);
  const refuse = (res, line) => {
    res.writeHead(403, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(line);
  };
  return {
    local: true,
    describe: `this computer only (loopback Host${extra.length ? ` + ${extra.join(", ")}` : ""}; changes from its own pages)`,
    allowedOrigins,
    http(req, res, next) {
      if (!isLoopbackHost(req, ports, allowedHosts)) return refuse(res, NOT_HERE);
      if (!writeAllowed(req, allowedOrigins)) return refuse(res, NOT_FROM_HERE);
      return next(LOCAL_OWNER);
    },
    upgrade(req, socket, head, next) {
      if (isLoopbackHost(req, ports, allowedHosts) && fromOwnPages(req, allowedOrigins))
        return next(LOCAL_OWNER);
      refuseUpgrade(socket);
    },
  };
}

export function refuseUpgrade(socket, status = "403 Forbidden") {
  try {
    socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

const isFn = (f) => typeof f === "function";

// Who gets /healthz's per-child detail (labels, pids, ports). /healthz itself is never gated: a supervisor must always be able to
// ask it, and everyone gets { ok }. The detail goes only to this computer on a loopback-only Studio (a loopback Host on the
// Studio's own port, or an allowed STUDIO_ALLOWED_HOSTS value). A Studio behind server hooks gives it to nobody unless the box
// sets STUDIO_HEALTH_DETAIL=1: such a box is usually reached through a tunnel or proxy, which can forward a public request with a
// loopback Host, and asking admission on every health poll would run the sign-in for a probe.
export function healthDetailAllowed(req, { hooks, ports, allowedHosts = [], env = process.env }) {
  if (!hooks || hooks.local) return isLoopbackHost(req, ports, allowedHosts);
  return env.STUDIO_HEALTH_DETAIL === "1";
}

// Tells the hook about one /healthz answer. Never awaited and never able to break the answer: a throw or
// a rejection is swallowed.
export function notifyHealth(hooks, report) {
  if (!hooks?.onHealth) return;
  Promise.resolve()
    .then(() => hooks.onHealth(report))
    .catch(() => {});
}

// Checks what a hook module returned. Anything malformed is an error, so a Studio never comes up with a
// half-installed sign-in.
export function checkHooks(h, where) {
  const bad = (why) => {
    throw new Error(`server hooks ${where}: ${why}`);
  };
  if (!h || typeof h !== "object") bad("install() must return an object");
  if (!h.admission || !isFn(h.admission.http) || !isFn(h.admission.upgrade))
    bad("admission.http and admission.upgrade are required functions");
  for (const k of ["transformShell", "place", "onHealth", "close"])
    if (h[k] != null && !isFn(h[k])) bad(`${k} must be a function`);
  if (h.child != null) {
    if (typeof h.child !== "object") bad("child must be an object");
    for (const k of ["env", "nodeArgs", "headers"])
      if (h.child[k] != null && !isFn(h.child[k])) bad(`child.${k} must be a function`);
  }
  return {
    local: false,
    describe: typeof h.describe === "string" && h.describe ? h.describe.slice(0, 200) : where,
    admission: h.admission,
    transformShell: h.transformShell ?? null,
    place: h.place ?? null,
    onHealth: h.onHealth ?? null,
    child: {
      env: h.child?.env ?? (() => ({})),
      nodeArgs: h.child?.nodeArgs ?? (() => []),
      headers: h.child?.headers ?? (() => ({})),
    },
    close: h.close ?? (() => {}),
  };
}

// Where the hook module is named: studio.json "serverHooks" (relative to the studio folder), else the
// STUDIO_SERVER_HOOKS environment variable. Neither means the loopback default.
export function hooksPath({ config, env = process.env, studioDir }) {
  const named = config?.serverHooks ?? env.STUDIO_SERVER_HOOKS ?? "";
  if (!named) return null;
  if (typeof named !== "string")
    throw new Error('server hooks: studio.json "serverHooks" must be a path');
  return path.resolve(studioDir, named.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
}

// Loads the hooks. A named module that fails to load or returns something malformed THROWS: the caller
// refuses to start. Falling back to the loopback gate would be wrong on a box whose tunnel or proxy
// reaches it from outside, because that tunnel's requests can carry a loopback Host.
export async function loadServerHooks({ config, env = process.env, studioDir, ctx, ports }) {
  const file = hooksPath({ config, env, studioDir });
  if (!file) {
    const admission = loopbackAdmission({
      ports,
      allowedHosts: allowedHostsFrom(env),
      allowedOrigins: allowedOriginsFrom(env),
    });
    return {
      local: true,
      allowedOrigins: admission.allowedOrigins,
      describe: admission.describe,
      admission,
      transformShell: null,
      place: null,
      onHealth: null,
      child: { env: () => ({}), nodeArgs: () => [], headers: () => ({}) },
      close: () => {},
    };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`server hooks ${file}: could not load (${e.message})`, { cause: e });
  }
  if (!isFn(mod.default))
    throw new Error(`server hooks ${file}: the default export must be install(ctx)`);
  return checkHooks(await mod.default(ctx), file);
}
