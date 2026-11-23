// The hosted browser terminals and the agents view (tools/hosted-terminals.mjs, mounted in tools/studio.mjs): real Studios
// booted with a test server-hook module, against stand-in ttyds on Unix sockets, a stand-in Herdr and a stand-in OpenRig daemon
// that record what reached them.
//
// The test hook admits a request that carries x-test-person, as ada@example.com: x-test-exp (the sign-in's expiry, seconds;
// "none" leaves it out), x-test-files (a files-only guest) and x-test-session (a session epoch registered with the hook's own
// `sessions`). Its own path /__test/end?session=<epoch> ends that session.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AGENTS_TYPE,
  AGENTS_WATCH,
  ROUTES,
  TEAM,
  TERMINAL,
  readRouteTarget,
  routeArgs,
  upgradeRoute,
} from "../tools/hosted-terminals.mjs";
import { readAgentsDaemon } from "../tools/task-views.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://box.example.invalid";
const delay = (n) => new Promise((r) => setTimeout(r, n));
const now = () => Math.floor(Date.now() / 1000);
const SECRET = "typed-secret-4f9c";
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
};
const scratch = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const HOOK = `
const streams = new Map();
const sessions = {
  check: async () => ({ ok: true }),
  register(epoch, onClose) {
    const entry = { epoch, onClose };
    streams.set(entry, true);
    return () => streams.delete(entry);
  },
};
function principal(req) {
  const h = req.headers, exp = h["x-test-exp"];
  const p = { workspace: h["x-test-files"] ? "files" : "full", access: "owner", email: "ada@example.com" };
  if (exp !== "none") p.exp = exp ? Number(exp) : Math.floor(Date.now() / 1000) + 3600;
  if (h["x-test-session"]) Object.assign(p, { session: h["x-test-session"], sessions });
  return p;
}
export default function install() {
  return {
    describe: "test door",
    admission: {
      http(req, res, next) {
        const url = new URL(req.url, "http://x");
        if (url.pathname === "/__test/end") {
          let n = 0;
          for (const e of streams.keys()) if (e.epoch === url.searchParams.get("session")) { n++; e.onClose({ code: 4003, reason: "Your account signed out." }); }
          return res.end(JSON.stringify({ ended: n }));
        }
        if (!req.headers["x-test-person"]) { res.writeHead(401); return res.end("sign in"); }
        next(principal(req));
      },
      upgrade(req, socket, head, next) {
        if (!req.headers["x-test-person"]) return socket.end("HTTP/1.1 401 Unauthorized\\r\\ncontent-length: 0\\r\\n\\r\\n");
        next(principal(req));
      },
    },
  };
}`;

// A stand-in ttyd on a Unix socket: its page over HTTP, its WebSocket echoing bytes; records what reached it.
async function fakeTtyd(t, socketPath, { mode = 0o600, endAfter = null } = {}) {
  const seen = [],
    sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ http: `${req.method} ${req.url}`, headers: req.headers });
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "ttyd=1" });
    res.end(`<!doctype html><title>ttyd</title><p>page ${req.url}</p>`);
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ ws: req.url, headers: req.headers });
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (d) => socket.write(d));
    socket.on("end", () => socket.destroy());
    if (endAfter !== null) setTimeout(() => socket.end(), endAfter);
  });
  await new Promise((r) => server.listen(socketPath, r));
  fs.chmodSync(socketPath, mode);
  t.after(
    () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  return seen;
}

// A stand-in Herdr whose answers follow the mode written to <dir>/mode, so one Studio can meet several Herdr states.
const T1 = "term_65ec4de94ab672",
  T2 = "term_65ec4de94c37a4",
  DASH = "term_65ec4de94cfbe5",
  SHPANE = "term_65ec4de94b6aa3",
  DUP = "term_65ec4de94e5f10";
const PANES = [
  { pane_id: "w1:p2", terminal_id: T1, label: "app.builder", agent_status: "working" },
  { pane_id: "w1:p4", terminal_id: T2, label: "app.checker", agent_status: "idle" },
  { pane_id: "w1:p3", terminal_id: SHPANE, label: "ops.lead", agent_status: "idle" }, // labelled, but a shell
  { pane_id: "w1:p5", terminal_id: DASH, agent_status: "unknown" }, // the dashboard: no label
];
function fakeHerdr(t) {
  const d = scratch(t, "herdr-"),
    bin = path.join(d, "herdr"),
    log = path.join(d, "calls.log"),
    modeFile = path.join(d, "mode");
  fs.writeFileSync(modeFile, "ok");
  const FG = {
    "w1:p2": [{ argv0: "tmux", argv: ["/usr/bin/tmux", "attach", "-t", "x"] }],
    "w1:p4": [{ argv: ["tmux", "attach", "-f", "ignore-size", "-t", "y"], name: "tmux: client" }],
    "w1:p3": [{ argv0: "sh", argv: ["sh"] }],
    "w1:p5": [{ argv0: "sh", argv: ["sh"] }],
    "w2:p1": [{ argv0: "tmux", argv: ["tmux", "attach"] }],
  };
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs"), a = process.argv.slice(2), mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const panes = ${JSON.stringify(PANES)};
if (mode === "dup") panes.push({ pane_id: "w2:p1", terminal_id: ${JSON.stringify(DUP)}, label: "app.builder" });
if (mode === "restarted") for (const p of panes) p.terminal_id = p.terminal_id.replace(/^term_65ec/, "term_77aa");
if (a[0] === "pane" && a[1] === "list") {
  if (mode === "list-fails") { process.stderr.write("no server"); process.exit(1); }
  const send = () => { out({ result: { type: "pane_list", panes } }); process.exit(0); };
  if (mode === "slow") setTimeout(send, 600); else send();
} else if (a[0] === "pane" && a[1] === "process-info") {
  if (mode === "no-fg") { out({ result: { process_info: {} } }); process.exit(0); }
  if (mode === "empty-fg") { out({ result: { process_info: { foreground_processes: [] } } }); process.exit(0); }
  out({ result: { process_info: { foreground_processes: (${JSON.stringify(FG)})[a[3]] || [] } } });
  process.exit(0);
}
`,
    { mode: 0o755 },
  );
  return {
    bin,
    mode: (m) => fs.writeFileSync(modeFile, m),
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}

// A stand-in OpenRig daemon for task views: cfg.core "a2" has task views and the ensure route, "a1" task views only, "old"
// neither. cfg.token guards /api/terminal/*. Every call recorded with its headers and body.
const VIEW = "qitem:fix-login-task",
  PLAN = "a".repeat(64),
  T3 = "term_aa03";
const DESCRIPTOR = { kind: "following", name: "Fix the login" };
const PREVIEW = {
  provider: "herdr",
  view: VIEW,
  viewDescriptor: DESCRIPTOR,
  planId: PLAN,
  task: {
    qitemId: "fix-login-task",
    name: "Fix the login",
    complete: true,
    issues: [],
    members: [
      {
        key: { hostId: "h1", nodeId: "n1" },
        seat: "app-builder@acme-team",
        availability: "available",
        viewerStatus: "verified",
        viewer: { terminalId: T1, readOnly: false },
      },
      {
        key: { hostId: "h1", nodeId: "n2" },
        seat: "app-checker@acme-team",
        availability: "available",
        viewerStatus: "unconfirmed",
        viewer: { terminalId: T2, readOnly: false },
      },
      {
        key: { hostId: null, nodeId: null },
        seat: "someone",
        availability: "unresolved",
        reason: "No local seat binding.",
        viewerStatus: "not-provisioned",
      },
      {
        key: { hostId: "h1", nodeId: "n5" },
        seat: "app-writer@acme-team",
        availability: "available",
        viewerStatus: "verified",
        viewer: { terminalId: T3 },
      },
    ],
  },
};
const OLD_404 = (view) => ({
  code: "view_not_found",
  error: `unknown view '${view}' — not a known rig, a mission:/slice: scope, or a saved-view id`,
});
async function fakeDaemon(t) {
  const calls = [];
  const cfg = {
    core: "a2",
    token: null,
    preview: null,
    ensure: { status: 200, body: { ok: true, viewer: { terminalId: T2 }, created: true } },
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      calls.push({
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers: req.headers,
        body,
      });
      const send = (s, o) => {
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (
        cfg.token &&
        u.pathname.startsWith("/api/terminal/") &&
        req.headers.authorization !== `Bearer ${cfg.token}`
      )
        return send(401, { error: "unauthorized" });
      if (u.pathname === "/api/terminal/preview") {
        if (cfg.core === "old") return send(404, OLD_404(u.searchParams.get("view")));
        if (cfg.preview) return cfg.preview(u, send);
        return send(200, PREVIEW);
      }
      if (
        u.pathname === "/api/terminal/viewer/ensure" &&
        req.method === "POST" &&
        cfg.core === "a2"
      ) {
        let j = null;
        try {
          j = JSON.parse(body);
        } catch {}
        if (!j || !j.view) return send(400, { ok: false, code: "body_invalid" });
        return send(cfg.ensure.status, cfg.ensure.body);
      }
      send(404, { ok: false, code: "not_found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    cfg,
    calls,
    reset: () => calls.splice(0),
    opened: () => calls.filter((c) => c.path.includes("/open")),
  };
}

// A real Studio, with the test hook unless hooks: false. Waits for its port and a healthy /healthz.
async function boot(t, env, { hooks = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-hosted-"));
  const studio = path.join(root, "studio");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  write(path.join(studio, "surfaces.json"), { chatSeats: [] });
  if (hooks) write(path.join(studio, "door.mjs"), HOOK);
  write(path.join(studio, "studio.json"), {
    port: 0,
    apps: [],
    ...(hooks ? { serverHooks: "door.mjs" } : {}),
  });
  const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
    env: {
      PATH: bin,
      OPENRIG_STUDIO_DIR: studio,
      SIGNIN_ORIGINS: `http://127.0.0.1:1, ${ORIGIN}`,
      ...env,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "",
    port = null;
  c.stdout.on("data", (b) => {
    log += b;
    port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
  });
  c.stderr.on("data", (b) => (log += b));
  t.after(async () => {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await delay(40);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i++) {
    if (c.exitCode !== null) throw Error(log);
    if (port && (await req(port, "/healthz").catch(() => null))?.status === 200) break;
    await delay(40);
  }
  assert.ok(port, log);
  return {
    port,
    log: () => log,
    get: (p, headers = ADA, method = "GET") => req(port, p, { headers, method }),
    post: (p, body, headers = { ...ADA, origin: ORIGIN, "content-type": "application/json" }) =>
      req(port, p, {
        headers,
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    place: async (headers = ADA) =>
      JSON.parse((await req(port, "/api/studio/place", { headers })).body),
  };
}

function req(port, p, { headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text,
          json: () => JSON.parse(text),
        }),
      );
    });
    r.on("error", reject);
    r.end(body);
  });
}
const ADA = { "x-test-person": "ada" };
const FILES = { ...ADA, "x-test-files": "1" };

// A raw upgrade: resolves { status, head, closed: Promise<ms>, bytes(), echo(text), socket }.
const upgrade = (port, p, { origin = ORIGIN, extra = ADA } = {}) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const headers = {
      host: "box.example.invalid",
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
      "sec-websocket-version": "13",
      ...(origin === null ? {} : { origin }),
      ...extra,
    };
    const t0 = Date.now();
    let buf = "",
      head = null,
      got = "";
    const waiters = [];
    const closed = new Promise((r) => s.on("close", () => r(Date.now() - t0)));
    s.on("error", () => {});
    s.setEncoding("latin1");
    s.on("connect", () =>
      s.write(
        `GET ${p} HTTP/1.1\r\n${Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("")}\r\n`,
      ),
    );
    s.on("data", (d) => {
      if (head === null) {
        buf += d;
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        head = buf.slice(0, i);
        got = buf.slice(i + 4);
        resolve({
          status: head.split("\r\n")[0],
          head,
          closed,
          socket: s,
          bytes: () => Buffer.from(got, "latin1"),
          echo: (text) =>
            new Promise((r) => {
              waiters.push(() => got.includes(text) && r(true));
              s.write(text);
              setTimeout(() => r(false), 2000);
            }),
        });
      } else {
        got += d;
        for (const w of waiters) w();
      }
    });
    closed.then(() => {
      if (head === null)
        resolve({
          status: buf.split("\r\n")[0] || "(closed)",
          head: buf,
          closed,
          socket: s,
          bytes: () => Buffer.alloc(0),
          echo: async () => false,
        });
    });
    setTimeout(() => s.destroy(), 8000).unref();
  });
const until = async (f, ms = 5000) => {
  for (let end = Date.now() + ms; Date.now() < end; await delay(50)) if (f()) return true;
  return f();
};
const CLOSE = (code, reason) =>
  Buffer.concat([
    Buffer.from([0x88, 2 + reason.length, code >> 8, code & 0xff]),
    Buffer.from(reason),
  ]);

test("off without hooks: the local terminal still serves /terminal/; no agents view, no agents API, place.agents null", async (t) => {
  const d = scratch(t, "off-"),
    tty = await fakeTtyd(t, path.join(d, "t.sock")),
    watch = await fakeTtyd(t, path.join(d, "w.sock"));
  const s = await boot(
    t,
    {
      STUDIO_TERMINAL_SOCKET: path.join(d, "t.sock"),
      STUDIO_AGENTS_WATCH_SOCKET: path.join(d, "w.sock"),
      STUDIO_HERDR_BIN: fakeHerdr(t).bin,
    },
    { hooks: false },
  );
  assert.match(s.log(), /agents off: only behind server hooks/);
  assert.doesNotMatch(s.log(), /^ {2}(agents|terminal)( \(|  :|:)/m, "no hosted route lines");
  const place = await s.place({});
  assert.equal(place.profile, "local");
  assert.equal(
    place.terminal,
    "/terminal/",
    "the local terminal (tools/terminal.mjs) is unchanged",
  );
  assert.deepEqual(place.agents, { watch: null, type: null });
  assert.equal((await s.get("/terminal/", {})).status, 200);
  assert.equal(tty.length, 1);
  assert.equal((await s.get("/api/agents/terminals", {})).status, 404);
  assert.equal((await s.get(`/api/agents/terminals?view=${VIEW}`, {})).status, 404);
  assert.equal(
    (await s.post("/api/agents/ensure", "{}", { "content-type": "application/json" })).status,
    404,
  );
  const u = await upgrade(s.port, `/agents/watch/ws?arg=${T1}`, {
    origin: `http://127.0.0.1:${s.port}`,
    extra: { host: `127.0.0.1:${s.port}` },
  });
  assert.doesNotMatch(u.status, / 101 /);
  assert.equal(watch.length, 0, "nothing reached the agents ttyd");
});

test("on with a hook: the box's terminal page and WebSocket, their checks, files-only, expiry, session end and readiness", async (t) => {
  const d = scratch(t, "on-"),
    sock = path.join(d, "t.sock"),
    teamSock = path.join(d, "team.sock");
  const tty = await fakeTtyd(t, sock),
    team = await fakeTtyd(t, teamSock);
  const s = await boot(t, { STUDIO_TERMINAL_SOCKET: sock, STUDIO_TEAM_SOCKET: teamSock });
  assert.match(
    s.log(),
    /terminal: \/terminal\/ -> the Unix socket .*t\.sock \(ttyd -b \/terminal\), behind admission/,
  );
  assert.match(s.log(), /team: \/team\/ -> the Unix socket .*team\.sock/);

  // place
  const place = await s.place();
  assert.equal(place.profile, "hosted");
  assert.equal(place.terminal, "/terminal/");
  assert.equal(place.team, "/team/");
  assert.deepEqual(place.agents, { watch: null, type: null });
  assert.equal(place.terminals.terminal.state, "available");
  assert.equal(place.terminals.agentsWatch.state, "not-configured");

  // The page: only content headers go on, framed by this Studio only, no cookie back.
  const r = await s.get("/terminal/?x=1", {
    ...ADA,
    cookie: "session=secret",
    authorization: "Bearer y",
    "x-forwarded-for": "1.2.3.4",
    accept: "text/html",
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /page \/terminal\/\?x=1/);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["content-security-policy"], "frame-ancestors 'self'");
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  for (const k of ["cookie", "authorization", "x-forwarded-for", "x-test-person", "origin"])
    assert.equal(tty[0].headers[k], undefined, `${k} must not reach ttyd`);
  assert.equal(tty[0].headers.accept, "text/html");
  const bare = await s.get("/terminal");
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.location, "/terminal/");
  assert.equal((await s.get("/team/")).status, 200);

  // The page: no admission, a foreign Origin, a cross-site fetch, a write, a files-only guest: refused before ttyd.
  const before = tty.length;
  assert.equal((await s.get("/terminal/", {})).status, 401, "the hook's own refusal");
  for (const [why, headers] of [
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ]) {
    const x = await s.get("/terminal/", { ...ADA, ...headers });
    assert.equal(x.status, 403, why);
    assert.equal(x.headers["x-openrig-terminal"], "not this box's Studio", why);
  }
  assert.equal((await s.get("/terminal/", ADA, "POST")).status, 405);
  const files = await s.get("/terminal/", FILES);
  assert.equal(files.status, 403);
  assert.equal(files.headers["x-openrig-terminal"], "not for a files-only sign-in");
  assert.equal((await s.get("/team/", FILES)).status, 403);
  assert.equal(tty.length, before, "ttyd saw no refused request");
  assert.equal(
    (await s.get("/terminal/", { ...ADA, origin: ORIGIN, "sec-fetch-site": "same-origin" })).status,
    200,
  );
  const fp = await s.place(FILES);
  assert.deepEqual([fp.terminal, fp.team, fp.agents.watch, fp.terminals], [null, null, null, null]);

  // The WebSocket: the fixed path, only the handshake; the audit says who and when, never what.
  const u = await upgrade(s.port, "/terminal/ws?host=10.0.0.1", {
    extra: { ...ADA, cookie: "session=secret", authorization: "Bearer y" },
  });
  assert.match(u.status, /^HTTP\/1\.1 101 /, u.head);
  assert.ok(await u.echo(SECRET), "bytes reach the shell and come back");
  u.socket.destroy();
  await u.closed;
  const w = tty.find((x) => x.ws);
  assert.equal(w.ws, "/terminal/ws", "the client's query goes nowhere");
  for (const k of ["cookie", "authorization", "origin", "x-test-person"])
    assert.equal(w.headers[k], undefined, `${k} must not reach ttyd`);
  assert.ok(await until(() => /terminal: closed for ada@example\.com/.test(s.log())));
  assert.match(s.log(), /terminal: opened by ada@example\.com at \d{4}-\d\d-\d\dT[\d:.]+Z/);
  assert.match(s.log(), /terminal: closed for ada@example\.com at \S+ \(closed by the browser\)/);
  assert.doesNotMatch(s.log(), new RegExp(SECRET), "nothing typed reaches the log");

  // The WebSocket's refusals: a foreign or missing Origin, no admission, a files-only guest, no expiry.
  const wsBefore = tty.filter((x) => x.ws).length;
  for (const [why, o, status] of [
    ["a foreign Origin", { origin: "https://evil.example" }, 403],
    ["no Origin", { origin: null }, 403],
    ["no admission", { extra: {} }, 401],
    ["files-only", { extra: FILES }, 403],
    ["no expiry", { extra: { ...ADA, "x-test-exp": "none" } }, 403],
    ["team, a foreign Origin", { origin: "https://evil.example", path: "/team/ws" }, 403],
  ]) {
    const x = await upgrade(s.port, o.path ?? "/terminal/ws", o);
    assert.match(x.status, new RegExp(`^HTTP/1\\.1 ${status} `), `${why}: ${x.status}`);
  }
  assert.equal(tty.filter((x) => x.ws).length, wsBefore, "ttyd saw no refused upgrade");
  assert.equal(team.filter((x) => x.ws).length, 0);

  // At exp: a close frame 4001 "sign-in expired", and the audit says so.
  const exp = await upgrade(s.port, "/terminal/ws", {
    extra: { ...ADA, "x-test-exp": String(now() + 2) },
  });
  assert.match(exp.status, /^HTTP\/1\.1 101 /);
  const ms = await Promise.race([exp.closed, delay(7000).then(() => Infinity)]);
  assert.ok(ms < 5000, `closed at expiry (${ms} ms)`);
  assert.ok(exp.bytes().includes(CLOSE(4001, "sign-in expired")));
  assert.ok(
    await until(() =>
      /terminal: closed for ada@example\.com at \S+ \(sign-in expired\)/.test(s.log()),
    ),
  );

  // The person's session ends: the team tunnel closes with the session's code and reason.
  const ses = await upgrade(s.port, "/team/ws", { extra: { ...ADA, "x-test-session": "e1" } });
  assert.match(ses.status, /^HTTP\/1\.1 101 /);
  assert.equal(team.at(-1).ws, "/team/ws");
  assert.equal(JSON.parse((await s.get("/__test/end?session=e1")).body).ended, 1);
  assert.ok((await Promise.race([ses.closed, delay(5000).then(() => null)])) !== null);
  assert.ok(ses.bytes().includes(CLOSE(4003, "Your account signed out.")));

  // Readiness: a socket open to group/others is not ready for page and WebSocket, and place says null.
  fs.chmodSync(sock, 0o660);
  const nr = await s.get("/terminal/");
  assert.equal(nr.status, 503);
  assert.equal(nr.headers["x-openrig-terminal"], "not ready");
  assert.match((await upgrade(s.port, "/terminal/ws")).status, /^HTTP\/1\.1 503 /);
  assert.equal((await s.place()).terminal, null);
  assert.equal((await s.place()).terminals.terminal.state, "unavailable");
  assert.ok(
    await until(() => /terminal: refused for ada@example\.com at \S+ \(not ready\)/.test(s.log())),
  );
  assert.doesNotMatch(s.log(), /evil\.example/, "refusal lines carry no values");
});

test("an invalid or unset socket: no route, place null, 503 'not ready'; the boot line says why; the agents API isn't set up", async (t) => {
  const s = await boot(t, { STUDIO_TERMINAL_SOCKET: "rel/t.sock" });
  assert.match(
    s.log(),
    /terminal off: STUDIO_TERMINAL_SOCKET must be an absolute, normalised path/,
  );
  const place = await s.place();
  assert.equal(place.terminal, null);
  assert.equal(place.team, null);
  assert.match(place.terminals.terminal.reason, /must be an absolute/);
  const team = await s.get("/team/");
  assert.equal(team.status, 503);
  assert.equal(team.headers["x-openrig-team"], "not ready");
  assert.match((await upgrade(s.port, "/terminal/ws")).status, /^HTTP\/1\.1 503 /);
  const list = await s.get("/api/agents/terminals");
  assert.equal(list.status, 503);
  assert.match(list.json().unreadable, /isn't set up/);
  const tv = await s.get(`/api/agents/terminals?view=${encodeURIComponent(VIEW)}`);
  assert.equal(tv.status, 503);
  assert.equal(tv.json().code, undefined, "not set up isn't 'unsupported'");
  assert.equal(
    (
      await s.post("/api/agents/ensure", {
        view: VIEW,
        member: { hostId: "h", nodeId: "n" },
        expectedPlan: PLAN,
      })
    ).status,
    503,
  );
  for (const [v, why] of [
    ["/tmp/../tmp/t.sock", /must be an absolute, normalised path/],
    ["/" + "x".repeat(120), /is too long/],
  ])
    assert.match(readRouteTarget(TERMINAL, { STUDIO_TERMINAL_SOCKET: v }).describe, why);
});

test("the agents routes pass on exactly their args, only as arg=, to their own sockets; the Herdr list, its refusals and its sharing", async (t) => {
  const d = scratch(t, "ags-"),
    w = path.join(d, "w.sock"),
    y = path.join(d, "y.sock");
  const watch = await fakeTtyd(t, w),
    type = await fakeTtyd(t, y),
    h = fakeHerdr(t);
  const s = await boot(t, {
    STUDIO_AGENTS_WATCH_SOCKET: w,
    STUDIO_AGENTS_TYPE_SOCKET: y,
    STUDIO_HERDR_BIN: h.bin,
    STUDIO_RIG_NAME: "acme-team",
  });
  assert.match(s.log(), /agents \(watch\): \/agents\/watch\/ -> the Unix socket/);
  assert.match(s.log(), /agents  : the terminal list from /);
  assert.match(s.log(), /session names <pod>-<member>@acme-team \(STUDIO_RIG_NAME\)/);
  assert.deepEqual((await s.place()).agents, { watch: "/agents/watch/", type: "/agents/type/" });

  // Routes: exact args only, each to its own socket; the audit names mode and id.
  for (const [p, want, fake] of [
    [`/agents/watch/ws?arg=${T1}&other=x`, `/agents/watch/ws?arg=${T1}`, watch],
    [`/agents/type/ws?arg=${T1}&arg=type`, `/agents/type/ws?arg=${T1}&arg=type`, type],
    [
      `/agents/type/ws?arg=${T2}&arg=takeover&host=evil`,
      `/agents/type/ws?arg=${T2}&arg=takeover`,
      type,
    ],
    [
      `/agents/watch/ws?arg=${encodeURIComponent(VIEW)}&arg=${T1}`,
      `/agents/watch/ws?arg=${encodeURIComponent(VIEW)}&arg=${T1}`,
      watch,
    ],
  ]) {
    const u = await upgrade(s.port, p);
    assert.match(u.status, /^HTTP\/1\.1 101 /, p);
    u.socket.destroy();
    assert.equal(fake.at(-1).ws, want, p);
  }
  assert.ok(
    await until(() =>
      new RegExp(`agents: watch ${T1} \\(${VIEW}\\) opened by ada@example\\.com`).test(s.log()),
    ),
  );
  assert.match(s.log(), new RegExp(`agents: takeover ${T2} opened by ada@example\\.com`));
  assert.equal((await s.get(`/agents/watch/?arg=${T1}`)).status, 200, "the tile's page");
  assert.equal(watch.at(-1).http, `GET /agents/watch/?arg=${T1}`);

  // Args not in the route's exact shape: 400 before ttyd.
  const n = watch.length + type.length;
  const bad = [
    "/agents/watch/ws",
    `/agents/watch/ws?arg=${T1}&arg=type`,
    "/agents/watch/ws?arg=..%2Fx",
    `/agents/watch/ws?arg=${T1}%3Brm`,
    `/agents/type/ws?arg=${T1}`,
    `/agents/type/ws?arg=${T1}&arg=type&arg=x`,
    `/agents/watch/ws?arg=${T1}&arg=${encodeURIComponent(VIEW)}`,
  ];
  for (const p of bad) {
    const u = await upgrade(s.port, p);
    u.socket.destroy();
    assert.match(u.status, /^HTTP\/1\.1 400 /, p);
  }
  for (const p of ["/agents/watch/?arg=nope", "/agents/watch/", `/agents/type/?arg=${T1}`]) {
    const r = await s.get(p);
    assert.equal(r.status, 400, p);
    assert.equal(r.headers["x-openrig-agents"], "not an agent terminal", p);
  }
  assert.match(
    (await upgrade(s.port, `/agents/watch/ws?arg=${T1}`, { origin: "https://evil.example" }))
      .status,
    /^HTTP\/1\.1 403 /,
  );
  assert.equal(watch.length + type.length, n, "ttyd never reached");

  // The list: the two tmux-attach tiles, not the dashboard or the labelled shell; session names from STUDIO_RIG_NAME.
  const r = await s.get("/api/agents/terminals");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.deepEqual(r.json(), {
    terminals: [
      {
        seat: "app.builder",
        session: "app-builder@acme-team",
        terminal_id: T1,
        state: "working",
        inUse: null,
      },
      {
        seat: "app.checker",
        session: "app-checker@acme-team",
        terminal_id: T2,
        state: "idle",
        inUse: null,
      },
    ],
    ambiguous: [],
  });
  assert.equal((await s.get("/api/agents/terminals", {})).status, 401, "behind admission");
  assert.equal((await s.get("/api/agents/terminals", FILES)).status, 403, "not for files-only");
  assert.equal((await s.get("/api/agents/terminals", ADA, "POST")).status, 405);
  // Two panes with one label: neither listed, the label named.
  h.mode("dup");
  const dup = (await s.get("/api/agents/terminals")).json();
  assert.deepEqual(
    dup.terminals.map((x) => x.seat),
    ["app.checker"],
  );
  assert.deepEqual(dup.ambiguous, ["app.builder"]);
  // After a Herdr restart: only the new ids, read fresh on every call.
  h.mode("restarted");
  const lists = () => h.calls().filter((c) => c[1] === "list").length;
  const l0 = lists();
  assert.deepEqual(
    (await s.get("/api/agents/terminals")).json().terminals.map((x) => x.terminal_id),
    [T1, T2].map((x) => x.replace(/^term_65ec/, "term_77aa")),
  );
  await s.get("/api/agents/terminals");
  assert.equal(lists() - l0, 2, "never cached");
  // Unreadable is said (503), never an empty list; an empty foreground is a real answer.
  for (const mode of ["list-fails", "no-fg"]) {
    h.mode(mode);
    const x = await s.get("/api/agents/terminals");
    assert.equal(x.status, 503, mode);
    assert.equal(x.headers["x-openrig-agents"], "unreadable", mode);
    assert.equal(x.json().terminals, undefined, mode);
  }
  h.mode("empty-fg");
  assert.deepEqual((await s.get("/api/agents/terminals")).json(), { terminals: [], ambiguous: [] });
  // Concurrent reads share one Herdr read; the next one after it settles is fresh.
  h.mode("slow");
  const l1 = lists();
  const rs = await Promise.all([1, 2, 3].map(() => s.get("/api/agents/terminals")));
  assert.deepEqual(
    rs.map((x) => x.status),
    [200, 200, 200],
  );
  assert.equal(lists() - l1, 1);
  await s.get("/api/agents/terminals");
  assert.equal(lists() - l1, 2);

  // A 0660 socket: that half not ready, place null for it only.
  fs.chmodSync(y, 0o660);
  assert.deepEqual((await s.place()).agents, { watch: "/agents/watch/", type: null });
  assert.equal(
    (await s.get(`/agents/type/?arg=${T1}&arg=type`)).headers["x-openrig-agents"],
    "not ready",
  );
});

test("task views from the box's daemon: the list, its refusals, and the person's ensure (Origin, JSON, size, the file's bearer)", async (t) => {
  const d = scratch(t, "tv-"),
    w = path.join(d, "w.sock"),
    tf = path.join(d, "daemon.token");
  await fakeTtyd(t, w);
  fs.writeFileSync(tf, "secret-bearer-123\n");
  fs.chmodSync(tf, 0o600);
  const daemon = await fakeDaemon(t);
  const s = await boot(t, {
    STUDIO_AGENTS_WATCH_SOCKET: w,
    STUDIO_AGENTS_DAEMON: daemon.url,
    STUDIO_AGENTS_DAEMON_TOKEN_FILE: tf,
  });
  assert.match(
    s.log(),
    /task views from the daemon at http:\/\/127\.0\.0\.1:\d+ \(preview and ensure only, never open\)/,
  );
  const list = () => s.get(`/api/agents/terminals?view=${encodeURIComponent(VIEW)}`);

  // The list: the daemon's members; a terminal ONLY for a verified viewer; readOnly unless the daemon says false.
  const r = await list();
  assert.equal(r.status, 200);
  const j = r.json();
  assert.deepEqual(j.viewDescriptor, DESCRIPTOR);
  assert.deepEqual(j.task, {
    qitemId: "fix-login-task",
    name: "Fix the login",
    complete: true,
    issues: [],
  });
  assert.equal(j.plan, PLAN);
  assert.equal(j.ensure, true, "the ensure route answers the {} probe with 400");
  assert.deepEqual(j.members, [
    {
      seat: "app-builder@acme-team",
      session: "app-builder@acme-team",
      key: { hostId: "h1", nodeId: "n1" },
      availability: "available",
      viewerStatus: "verified",
      terminal_id: T1,
      readOnly: false,
    },
    {
      seat: "app-checker@acme-team",
      session: "app-checker@acme-team",
      key: { hostId: "h1", nodeId: "n2" },
      availability: "available",
      viewerStatus: "unconfirmed",
    },
    {
      seat: "someone",
      key: { hostId: null, nodeId: null },
      availability: "unresolved",
      reason: "No local seat binding.",
      viewerStatus: "not-provisioned",
    },
    {
      seat: "app-writer@acme-team",
      session: "app-writer@acme-team",
      key: { hostId: "h1", nodeId: "n5" },
      availability: "available",
      viewerStatus: "verified",
      terminal_id: T3,
      readOnly: true,
    },
  ]);
  const prev = daemon.calls.find((c) => c.path === "/api/terminal/preview");
  assert.deepEqual(prev.query, { view: VIEW, provider: "herdr" });
  assert.equal(prev.headers.authorization, "Bearer secret-bearer-123");
  assert.deepEqual(
    daemon.calls.filter((c) => c.path === "/api/terminal/viewer/ensure").map((c) => c.body),
    ["{}"],
    "the probe sends {} only",
  );
  daemon.cfg.core = "a1";
  assert.equal((await list()).json().ensure, false, "task views without the ensure route");

  // The list's refusals: an old daemon says so with its code; any other 404 is unreadable; the view in its exact shape only.
  daemon.cfg.core = "old";
  const old = await list();
  assert.equal(old.status, 503);
  assert.equal(old.json().code, "task_views_unsupported");
  daemon.cfg.core = "a2";
  daemon.cfg.preview = (u, send) =>
    send(404, {
      code: "view_not_found",
      error: `unknown local queue episode '${u.searchParams.get("view").slice(6)}'`,
    });
  assert.equal((await list()).status, 404, "a daemon that doesn't know this task");
  daemon.cfg.preview = (u, send) => send(404, { error: "upstream temporarily unavailable" });
  const other = await list();
  assert.equal(other.status, 503);
  assert.equal(other.json().code, undefined);
  assert.match(other.json().error, /couldn't be read/);
  daemon.cfg.preview = null;
  daemon.cfg.token = "another-token";
  assert.match((await list()).json().error, /refused this box's token/);
  daemon.cfg.token = null;
  daemon.reset();
  for (const q of [
    "view=rig:acme",
    "view=qitem:",
    "view=qitem:../x",
    `view=${encodeURIComponent(VIEW)}&provider=other`,
    `view=${encodeURIComponent(VIEW)}&view=qitem:q2`,
    "x=1",
  ]) {
    const b = await s.get(`/api/agents/terminals?${q}`);
    assert.equal(b.status, 400, q);
    assert.equal(b.headers["x-openrig-agents"], "not a task view", q);
  }
  assert.equal(
    (await s.get(`/api/agents/terminals?view=${encodeURIComponent(VIEW)}`, FILES)).status,
    403,
  );
  assert.deepEqual(daemon.calls, [], "no refused list reached the daemon");

  // Ensure: from this box's page only, in the exact shape, JSON, small.
  const good = { view: VIEW, member: { hostId: "h1", nodeId: "n2" }, expectedPlan: PLAN };
  const H = { ...ADA, origin: ORIGIN, "content-type": "application/json" };
  assert.equal(
    (
      await s.post("/api/agents/ensure", good, {
        origin: ORIGIN,
        "content-type": "application/json",
      })
    ).status,
    401,
  );
  assert.equal(
    (await s.post("/api/agents/ensure", good, { ...H, origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(
    (await s.post("/api/agents/ensure", good, { ...ADA, "content-type": "application/json" }))
      .status,
    403,
  );
  assert.equal((await s.post("/api/agents/ensure", good, { ...H, ...FILES })).status, 403);
  assert.equal(
    (await s.post("/api/agents/ensure", good, { ...H, "content-type": "text/plain" })).status,
    415,
  );
  assert.equal((await s.get("/api/agents/ensure")).status, 405);
  for (const b of [
    { ...good, terminalId: T1 },
    { ...good, member: { ...good.member, terminalId: T1 } },
    { ...good, expectedPlan: "x" },
    { ...good, view: "rig:acme" },
    { ...good, view: [VIEW] },
    { ...good, member: { hostId: 7, nodeId: "n2" } },
    { view: VIEW, member: { hostId: "h1" }, expectedPlan: PLAN },
    [good],
  ]) {
    const x = await s.post("/api/agents/ensure", b);
    assert.equal(x.status, 400, JSON.stringify(b));
    assert.equal(x.json().code, "body_invalid");
  }
  assert.equal((await s.post("/api/agents/ensure", "{not json")).status, 400);
  const big = await s.post(
    "/api/agents/ensure",
    JSON.stringify({ ...good, pad: "x".repeat(5000) }),
  );
  assert.equal(big.status, 413);
  assert.equal(big.json().code, "body_invalid");
  assert.deepEqual(daemon.calls, [], "no refused ensure reached the daemon");
  const ok = await s.post("/api/agents/ensure", good, {
    ...H,
    authorization: "Bearer from-the-page",
    cookie: "c=1",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { ok: true, viewer: { terminalId: T2 }, created: true });
  const sent = daemon.calls.find((c) => c.path === "/api/terminal/viewer/ensure");
  assert.deepEqual(JSON.parse(sent.body), { ...good, provider: "herdr" });
  assert.equal(
    sent.headers.authorization,
    "Bearer secret-bearer-123",
    "the file's bearer, not the page's",
  );
  assert.equal(sent.headers.cookie, undefined);
  assert.ok(
    await until(() =>
      /agents: ensure qitem:fix-login-task h1\/n2 by ada@example\.com at \S+ -> created/.test(
        s.log(),
      ),
    ),
  );
  daemon.cfg.ensure = { status: 409, body: { ok: false, code: "preview_changed", error: "x" } };
  const changed = await s.post("/api/agents/ensure", good);
  assert.equal(changed.status, 409);
  assert.deepEqual(changed.json(), daemon.cfg.ensure.body, "the daemon's answer as is");
  fs.chmodSync(tf, 0o644);
  daemon.reset();
  const loose = await s.post("/api/agents/ensure", good);
  assert.equal(loose.status, 503);
  assert.equal(loose.json().code, "not_set_up");
  assert.deepEqual(daemon.calls, [], "a readable token file is refused before the daemon");
  assert.doesNotMatch(s.log(), /secret-bearer-123/, "the bearer is never logged");
  assert.deepEqual(daemon.opened(), [], "never /api/terminal/open");
});

test("route shapes: the agents routes take their args, the others none; the daemon setting must be loopback http", () => {
  assert.deepEqual(ROUTES, [TERMINAL, AGENTS_WATCH, AGENTS_TYPE, TEAM]);
  assert.deepEqual(routeArgs(TEAM, "/team/?arg=any"), { pass: [], id: null, mode: null });
  assert.deepEqual(routeArgs(AGENTS_WATCH, `/x?arg=${T1}`).pass, [T1]);
  assert.equal(routeArgs(AGENTS_TYPE, `/x?arg=${T1}`), null);
  for (const [v, why] of [
    ["https://127.0.0.1:9", /must be http:\/\//],
    ["http://10.0.0.5:7433", /must name a loopback host/],
    ["http://127.0.0.1", /needs a port/],
    ["http://127.0.0.1:9/x", /only a scheme/],
  ])
    assert.match(readAgentsDaemon({ STUDIO_AGENTS_DAEMON: v }).describe, why, v);
  assert.deepEqual(readAgentsDaemon({}), { target: null, describe: null });
});

test("team: the same tunnel closes at expiry and when the person's session ends; no query-selected command", async (t) => {
  const d = scratch(t, "team-"),
    sock = path.join(d, "team.sock"),
    seen = await fakeTtyd(t, sock);
  for (const code of [4001, 4003]) {
    let revoke;
    const sessions = {
      register: (epoch, fn) => {
        assert.equal(epoch, "verified-epoch");
        revoke = fn;
        return () => {};
      },
    };
    const proxy = http.createServer();
    proxy.on("upgrade", (rq, socket, head) =>
      upgradeRoute(TEAM, rq, socket, head, {
        target: { socketPath: sock },
        origins: new Set([ORIGIN]),
        principal: {
          email: "ada@example.com",
          exp: Date.now() / 1000 + (code === 4001 ? 0.35 : 60),
          session: "verified-epoch",
          sessions,
        },
        log: () => {},
      }),
    );
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const c = await upgrade(proxy.address().port, "/team/ws?arg=untrusted", { extra: {} });
    assert.match(c.status, /101/);
    assert.equal(seen.at(-1).ws, "/team/ws");
    if (code !== 4001) revoke({ code, reason: "account signed out" });
    assert.ok(
      (await Promise.race([c.closed, delay(3000).then(() => null)])) !== null,
      `${code} closed`,
    );
    assert.equal(c.bytes()[0], 0x88);
    assert.deepEqual([...c.bytes().subarray(2, 4)], [code >> 8, code & 255]);
    await new Promise((r) => proxy.close(r));
  }
});
