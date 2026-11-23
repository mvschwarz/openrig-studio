// A hosted box's browser terminals, behind an admission hook (contract/server-hooks.md). tools/terminal.mjs serves a loopback-only
// Studio; this module replaces it whenever server hooks are installed, so the same sockets get the stricter front end a Studio
// reached from outside needs. studio.mjs picks one of the two at boot; they never run together.
//
// Each route is a ttyd on its own Unix socket, its page and assets proxied and its WebSocket tunnelled (tools/desktop.mjs's
// tunnel). ROUTES below is the whole list: each has its own socket, paths, refusal header and audit word; none is chosen by the
// client.
//   /terminal/ + /terminal/ws from STUDIO_TERMINAL_SOCKET: the box's shell (ttyd -W -b /terminal, as tools/start-terminal.mjs
//     starts it).
//   /team/ + /team/ws from STUDIO_TEAM_SOCKET: one full Herdr client per browser, attached to the existing team session
//     (tools/herdr-client.mjs). No ttyd -a: the browser can't choose a command, session or upstream.
//   /agents/watch/ + /agents/watch/ws from STUDIO_AGENTS_WATCH_SOCKET: ONE agent terminal per browser connection through the fixed
//     wrapper tools/herdr-tile.mjs, ttyd -a WITHOUT -W, so read-only by ttyd's own flag;
//   /agents/type/ + /agents/type/ws from STUDIO_AGENTS_TYPE_SOCKET: the same with ttyd -a -W.
// The agents routes carry the browser's ?arg= values to ttyd (-a gives them to the wrapper): only those, only in the exact shape
// (watch: a terminal id; type: a terminal id and type|takeover; either may start with a task view or end with the selected
// conversation), checked here before ttyd is reached and again by the wrapper, which also checks the id is one of this box's agent
// terminals now. The audit line names the terminal id and mode, never content.
//
// On top of admission, for every route:
//   - ONE fixed target the client can't choose. At each request the socket must be a socket, owned by this process's user, with
//     no group or other access, or the request is refused with 503 "not ready" and /api/studio/place says <key>: null. No TCP
//     fallback: any local user can reach a port.
//   - only an admitted principal that isn't files-only; a files-only guest gets 403.
//   - the WebSocket: Origin must be one of the box's own addresses (SIGNIN_ORIGINS); only the handshake headers go on; it is
//     closed with 4001 "sign-in expired" at the principal's exp, between two frames, and when the principal's sessions end it.
//     Its path upstream is always the route's own /ws, plus only the args checked here.
//   - the page and its assets: GET and HEAD only (ttyd's page needs nothing else); an Origin header, when the browser sends one,
//     must be the box's own; a cross-site request (Sec-Fetch-Site: cross-site) is refused; the page may be framed only by this
//     Studio (frame-ancestors 'self'); only content-negotiation headers go on, never a cookie, token or admission's headers; a
//     Set-Cookie from upstream is dropped.
//   - an audit line on the Studio's log per terminal opened, closed or refused here: the principal's e-mail, the time and why:
//     closed by the browser, sign-in expired, a session's own reason, or the terminal ended (ttyd hung up first); refused: not this
//     box's Studio, not ready, sign-in expired, or the terminal not answering. Never what was typed or shown, a token or a
//     credential.
// WHAT HAPPENS TO THE SHELL. ttyd starts a fresh process for each WebSocket and ends it when that WebSocket closes. So closing the
// tab, a dropped network, the sign-in's expiry or a reconnect each end that shell and anything running in it; a re-entry is a new
// shell. This Studio adds no session of its own and keeps nothing running. A box that wants a shell to survive says so in ttyd's
// command (e.g. tmux new -A).
//
// The agents view's API, also only here:
//   GET  /api/agents/terminals             this box's agent terminals, from its own Herdr through ONE fixed binary, STUDIO_HERDR_BIN
//   GET  /api/agents/terminals?view=qitem:<id>   one task's agents from the box's OpenRig daemon (tools/task-views.mjs)
//   POST /api/agents/ensure                the person's explicit ensure of a task member's viewer, from this box's own page (Origin)
import http from "node:http";
import path from "node:path";
import { desktopReady, tunnelWebSocket } from "./desktop.mjs";
import { agentTerminals, herdrBin, splitOriginal } from "./herdr-tile.mjs";
import { VIEW, ensureBody, ensureViewer, readAgentsDaemon, readTaskView } from "./task-views.mjs";

const ID = /^term_[0-9a-f]{1,64}$/;
// args(list) -> the args to pass on, or null when they aren't exactly this route's shape; absent for a route that takes none.
const route = (key, base, env, what, word, args) => ({
  key,
  env,
  what,
  word,
  args,
  path: `${base}/`,
  ws: `${base}/ws`,
  header: `x-openrig-${word}`,
});
export const TERMINAL = route(
  "terminal",
  "/terminal",
  "STUDIO_TERMINAL_SOCKET",
  "the terminal",
  "terminal",
);
export const TEAM = route("team", "/team", "STUDIO_TEAM_SOCKET", "the team workspace", "team");
// Each takes either the terminal alone (membership by label) or a task view first (the daemon's verified viewer of that task):
// watch [view] <id>; type [view] <id> type|takeover. A tile next to an agent's chat may add the selected conversation,
// --node <nodeId> --conversation <hash> (both or neither, never with a view), which herdr-tile.mjs checks against OpenRig before
// it attaches and while it's attached; its shape is herdr-tile's own splitOriginal.
const MODE = (m) => m === "type" || m === "takeover";
const withOriginal = (shape) => (all) => {
  const s = splitOriginal(all);
  if (!s) return null;
  const r = shape(s.rest);
  return r && (!s.original || !r.view) ? { ...r, pass: all } : null;
};
export const AGENTS_WATCH = route(
  "agentsWatch",
  "/agents/watch",
  "STUDIO_AGENTS_WATCH_SOCKET",
  "the agents view",
  "agents",
  withOriginal((a) =>
    a.length === 1 && ID.test(a[0])
      ? { pass: a, id: a[0], mode: "watch", view: null }
      : a.length === 2 && VIEW.test(a[0]) && ID.test(a[1])
        ? { pass: a, id: a[1], mode: "watch", view: a[0] }
        : null,
  ),
);
export const AGENTS_TYPE = route(
  "agentsType",
  "/agents/type",
  "STUDIO_AGENTS_TYPE_SOCKET",
  "the agents view",
  "agents",
  withOriginal((a) =>
    a.length === 2 && ID.test(a[0]) && MODE(a[1])
      ? { pass: a, id: a[0], mode: a[1], view: null }
      : a.length === 3 && VIEW.test(a[0]) && ID.test(a[1]) && MODE(a[2])
        ? { pass: a, id: a[1], mode: a[2], view: a[0] }
        : null,
  ),
);
export const ROUTES = [TERMINAL, AGENTS_WATCH, AGENTS_TYPE, TEAM];
// The client's ?arg= values for a route that takes them: { pass, id, mode }, or null when they aren't exactly its shape. Any other
// query parameter is dropped (ttyd -a reads only arg=).
export const routeArgs = (r, url) =>
  r.args
    ? r.args(new URL(url, "http://x").searchParams.getAll("arg"))
    : { pass: [], id: null, mode: null };
const withArgs = (base, pass) =>
  base + (pass.length ? "?" + pass.map((v) => "arg=" + encodeURIComponent(v)).join("&") : "");
const PAGE_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "range",
  "user-agent",
];

export const isRoutePath = (r, p) => p === r.path.slice(0, -1) || p.startsWith(r.path);

export function readRouteTarget(r, env = process.env) {
  const sock = env[r.env];
  if (sock === undefined || sock === "") return { target: null, describe: null };
  const off = (why) => ({ target: null, describe: `${r.word} off: ${r.env} ${why}` });
  if (!path.isAbsolute(sock) || path.normalize(sock) !== sock || sock.endsWith("/"))
    return off("must be an absolute, normalised path");
  if (Buffer.byteLength(sock) > 100) return off("is too long for a Unix socket path");
  // "terminal", "team", "agents (watch)", "agents (type)".
  const sub = r.path.slice(1, -1).split("/")[1];
  const name = sub ? `${r.word} (${sub})` : r.word;
  return {
    target: { socketPath: sock, path: r.ws },
    describe: `${name}: ${r.path} -> the Unix socket ${sock} (ttyd -b ${r.path.slice(0, -1)}), behind admission, closed at the sign-in's expiry`,
  };
}

// Ready now: the socket is a socket, ours, mode 0600 or tighter (the same check as the desktop's socket). Checked per request.
export const routeReady = (target) => Boolean(target?.socketPath) && desktopReady(target);

const notReady = (r, res) => {
  const body = JSON.stringify({ ok: false, error: `${r.what} isn't set up on this workspace` });
  res.writeHead(503, {
    "content-type": "application/json",
    "cache-control": "no-store",
    [r.header]: "not ready",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};
const refused = (r, res, status, why) => {
  res.writeHead(status, { "cache-control": "no-store", [r.header]: why, "content-length": 0 });
  res.end();
};

// The page and its assets. req has passed admission.
export function proxyRoutePage(r, req, res, { target, origins }) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-length": 0 });
    return res.end();
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !origins.has(origin))
    return refused(r, res, 403, "not this box's Studio");
  if (req.headers["sec-fetch-site"] === "cross-site")
    return refused(r, res, 403, "not this box's Studio");
  if (!routeReady(target)) return notReady(r, res);
  const u = new URL(req.url, "http://x");
  // ttyd's page loads its assets relative to its base, so the bare path is sent there first.
  if (u.pathname === r.path.slice(0, -1)) {
    res.writeHead(308, { location: r.path + u.search, "content-length": 0 });
    return res.end();
  }
  // The tile's own page (the base itself) must carry exactly the route's args; its assets carry none.
  if (r.args && u.pathname === r.path && !routeArgs(r, req.url))
    return refused(r, res, 400, "not an agent terminal");
  const headers = { host: "localhost" };
  for (const k of PAGE_HEADERS) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
  const upPath = r.args
    ? withArgs(u.pathname, routeArgs(r, req.url)?.pass ?? [])
    : u.pathname + u.search;
  const up = http.request(
    { socketPath: target.socketPath, path: upPath, method: req.method, headers },
    (res2) => {
      const h = { ...res2.headers };
      delete h["set-cookie"];
      h["content-security-policy"] = "frame-ancestors 'self'";
      h["x-frame-options"] = "SAMEORIGIN";
      h["cache-control"] = "no-store";
      res.writeHead(res2.statusCode || 502, h);
      res2.pipe(res);
    },
  );
  up.setTimeout(10000, () => up.destroy(new Error("timeout")));
  up.on("error", () => {
    if (!res.headersSent) refused(r, res, 502, `${r.what} isn't running`);
    else res.destroy();
  });
  req.on("close", () => {
    if (!res.writableEnded) up.destroy();
  });
  up.end();
}

// The WebSocket. req has passed admission; principal is what admission said ({ email?, exp, session?, sessions? }). log is where
// the audit lines go, each starting with the route's own word ("terminal:", "agents:").
export function upgradeRoute(
  r,
  req,
  socket,
  head,
  { target, origins, principal, log = console.log, now = Date.now },
) {
  const who = String(principal?.email || "unknown"),
    at = () => new Date(now()).toISOString();
  const a = routeArgs(r, req.url);
  // For the agents view the line names the mode and terminal id (never content): "agents: watch term_… opened by …".
  const what = a?.id ? ` ${a.mode} ${a.id}${a.view ? ` (${a.view})` : ""}` : "";
  if (!a) {
    log(`${r.word}: refused for ${who} at ${at()} (not an agent terminal)`);
    try {
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nconnection: close\r\n${r.header}: not an agent terminal\r\ncontent-length: 0\r\n\r\n`,
      );
    } catch {
      socket.destroy();
    }
    return;
  }
  tunnelWebSocket(req, socket, head, {
    target: { ...target, path: withArgs(r.ws, a.pass) },
    origins,
    exp: principal?.exp,
    sessions: principal?.sessions,
    session: principal?.session,
    now,
    header: r.header,
    what: r.what,
    onOpen: () => log(`${r.word}:${what} opened by ${who} at ${at()}`),
    onClose: (why) => log(`${r.word}:${what} closed for ${who} at ${at()} (${why})`),
    onRefuse: (why) => log(`${r.word}:${what} refused for ${who} at ${at()} (${why})`),
  });
}

// Each listed terminal's session name, as OpenRig names a seat (<pod>-<member>@<rig>), needs this box's rig, from ONE fixed
// configured name, STUDIO_RIG_NAME, never guessed. Unset or not a plain name: no session field, and the page shows the seat.
const RIG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENSURE_MAX = 4096;

// The routes and the agents view's API for a Studio behind admission. studio.mjs calls request() and upgrade() for every admitted
// request and upgrade; each answers true when the path is one of its own. place() says what /api/studio/place reports.
export function createHostedTerminals({ env = process.env, origins, log = console.log }) {
  const ttyds = ROUTES.map((r) => ({ r, ...readRouteTarget(r, env) }));
  const lines = ttyds.filter((t) => t.describe).map((t) => t.describe);
  const agentsOn = ttyds.some((t) => t.r.word === "agents" && t.target);
  const herdr = agentsOn ? herdrBin(env) : null;
  const rigName = agentsOn && RIG_NAME.test(env.STUDIO_RIG_NAME ?? "") ? env.STUDIO_RIG_NAME : null;
  const sessionOf = (seat) => (rigName ? `${seat.replace(".", "-")}@${rigName}` : undefined);
  const taskDaemon = agentsOn ? readAgentsDaemon(env) : { target: null, describe: null };
  if (agentsOn) {
    lines.push(
      herdr
        ? `agents  : the terminal list from ${herdr} (membership interim: Herdr pane label + a tmux-attach process)`
        : "agents  : STUDIO_HERDR_BIN isn't an absolute path to an executable, so the list of agent terminals reads unreadable",
      rigName
        ? `agents  : session names <pod>-<member>@${rigName} (STUDIO_RIG_NAME)`
        : `agents  : no session names: STUDIO_RIG_NAME is ${env.STUDIO_RIG_NAME ? "not a plain rig name" : "unset"}, so the page shows each seat`,
    );
    if (taskDaemon.describe) lines.push(taskDaemon.describe);
  }
  // Concurrent list reads share one Herdr read (callers arriving while it runs get its answer); nothing is kept once it settles,
  // so every later read is fresh. The attach path (tools/herdr-tile.mjs) always reads on its own.
  let agentsRead = null;
  const readAgents = () =>
    (agentsRead ??= agentTerminals(herdr).finally(() => {
      agentsRead = null;
    }));
  const open = new Set();

  const status = (t) => {
    if (routeReady(t.target)) return { path: t.r.path, state: "available" };
    if (t.target)
      return {
        path: null,
        state: "unavailable",
        reason: `The configured ${t.r.env} socket is unavailable or isn't owned privately by this user.`,
      };
    return {
      path: null,
      state: "not-configured",
      reason: t.describe ?? `Set ${t.r.env} to the private Unix socket of its ttyd listener.`,
    };
  };
  const place = () => Object.fromEntries(ttyds.map((t) => [t.r.key, status(t)]));

  const json = (req, res, status, o, extra = {}) => {
    const body = JSON.stringify(o);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      ...extra,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  // The agents view's tiles: this box's agent terminals, from its own Herdr, never from the page. A read that fails says so (503),
  // never an empty list. inUse is null: Herdr's list can't say whether a terminal already has a controller. Read fresh every
  // call: a Herdr restart renumbers every terminal, so the page re-reads this on every (re)entry and on a refused attach.
  function terminals(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      return res.end();
    }
    const send = (status, o) =>
      json(req, res, status, o, status === 503 ? { "x-openrig-agents": "unreadable" } : {});
    // ?view=qitem:<id>: one task's agents from the daemon; the only parameter, in its exact shape. Without it, the box's Herdr
    // list (membership by label, interim).
    const params = [...url.searchParams.keys()];
    if (params.length) {
      const view = url.searchParams.get("view");
      if (params.length !== 1 || params[0] !== "view" || !VIEW.test(view ?? "")) {
        res.writeHead(400, { "cache-control": "no-store", "x-openrig-agents": "not a task view" });
        return res.end();
      }
      if (!taskDaemon.target)
        return send(503, { ok: false, error: "task views aren't set up on this workspace" });
      return readTaskView(taskDaemon.target, view).then(
        (r) => send(r.status, r.body),
        () => send(503, { ok: false, error: "this workspace's agents couldn't be read just now" }),
      );
    }
    if (!herdr)
      return send(503, { ok: false, unreadable: "the agents view isn't set up on this workspace" });
    // ambiguous: the seat labels two panes share, so neither is listed (never one picked); [] when none.
    return readAgents().then(
      (now) =>
        send(200, {
          terminals: now.terminals.map((x) => ({
            seat: x.seat,
            session: sessionOf(x.seat),
            terminal_id: x.terminal_id,
            state: x.status,
            inUse: null,
          })),
          ambiguous: now.ambiguous.map((x) => x.seat),
        }),
      () =>
        send(503, {
          ok: false,
          unreadable: "the agents in this workspace couldn't be read just now",
        }),
    );
  }

  // The person's explicit ensure of a task member's viewer: POST JSON {view, member {hostId, nodeId}, expectedPlan} from this box's
  // own page (Origin), forwarded to the daemon with the bearer from its fixed file; its answer as is. No terminal id is accepted
  // from the page; nothing here closes, relayouts, takes over or starts anything.
  function ensure(req, res, principal) {
    const send = (status, o, extra) => json(req, res, status, o, extra);
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-length": 0 });
      return res.end();
    }
    if (typeof req.headers.origin !== "string" || !origins.has(req.headers.origin))
      return send(403, { ok: false, error: "not this box's Studio" });
    if (!/^application\/json(;|$)/i.test(req.headers["content-type"] || ""))
      return send(415, { ok: false, error: "JSON only" });
    if (!taskDaemon.target)
      return send(503, { ok: false, error: "task views aren't set up on this workspace" });
    let raw = "",
      big = false;
    req.setEncoding("utf8");
    req.on("data", (d) => {
      if (big) return;
      raw += d;
      if (raw.length > ENSURE_MAX) {
        big = true;
        raw = "";
        send(
          413,
          { ok: false, code: "body_invalid", error: `at most ${ENSURE_MAX} bytes` },
          { connection: "close" },
        );
      }
    });
    req.on("end", async () => {
      if (big) return;
      let body = null;
      try {
        body = ensureBody(JSON.parse(raw));
      } catch {}
      if (!body)
        return send(400, {
          ok: false,
          code: "body_invalid",
          error: "expected {view, member {hostId, nodeId}, expectedPlan}",
        });
      const r = await ensureViewer(taskDaemon.target, body);
      log(
        `agents: ensure ${body.view} ${body.member.hostId}/${body.member.nodeId} by ${String(principal?.email || "unknown")} at ${new Date().toISOString()} -> ${r.body?.ok ? (r.body.created ? "created" : "reused") : r.body?.code || r.status}`,
      );
      send(r.status, r.body);
    });
  }

  function request(req, res, url, principal) {
    const filesOnly = principal?.workspace === "files";
    const t = ttyds.find((x) => isRoutePath(x.r, url.pathname));
    if (t) {
      if (filesOnly) refused(t.r, res, 403, "not for a files-only sign-in");
      else if (!t.target) notReady(t.r, res);
      else proxyRoutePage(t.r, req, res, { target: t.target, origins });
      return true;
    }
    if (url.pathname !== "/api/agents/terminals" && url.pathname !== "/api/agents/ensure")
      return false;
    if (filesOnly) {
      res.writeHead(403, {
        "cache-control": "no-store",
        "x-openrig-agents": "not for a files-only sign-in",
        "content-length": 0,
      });
      res.end();
    } else if (url.pathname === "/api/agents/terminals") terminals(req, res, url);
    else ensure(req, res, principal);
    return true;
  }

  // studio.mjs has already refused a files-only principal's upgrades.
  function upgrade(req, socket, head, principal) {
    const url = new URL(req.url, "http://x");
    const t = ttyds.find((x) => url.pathname === x.r.ws);
    if (!t) return false;
    if (!t.target) {
      log(`${t.r.word}: refused at ${new Date().toISOString()} (not set up)`);
      try {
        socket.end(
          `HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n${t.r.header}: not ready\r\ncontent-length: 0\r\n\r\n`,
        );
      } catch {
        socket.destroy();
      }
      return true;
    }
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    upgradeRoute(t.r, req, socket, head, { target: t.target, origins, principal, log });
    return true;
  }

  return {
    lines,
    place,
    request,
    upgrade,
    close: () => {
      for (const s of open) s.destroy();
    },
  };
}
