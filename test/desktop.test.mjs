// The Desktop WebSocket (tools/desktop.mjs, mounted in tools/studio.mjs): a real Studio booted with a test server-hook module
// and STUDIO_DESKTOP_WS (or STUDIO_DESKTOP_SOCKET) pointing at a stand-in websockify in this process.
//
// The test hook admits a request that carries x-test-person, as a principal built from test headers: x-test-exp (the
// sign-in's expiry, seconds; "none" leaves it out), x-test-files (a files-only guest) and x-test-session (the session epoch,
// checked and registered with the hook's own `sessions`). Its own path /__test/end?session=<epoch> ends a session, which
// fires every registered onClose for it.
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
  DESKTOP_PATH,
  desktopAnswering,
  frameTracker,
  readDesktopTarget,
} from "../tools/desktop.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://box.example.invalid";
const delay = (n) => new Promise((r) => setTimeout(r, n));
const now = () => Math.floor(Date.now() / 1000);
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
};

const HOOK = `
const streams = new Map();
const sessions = {
  async check(epoch) {
    return epoch === "revoked" ? { ok: false, reason: "session ended" } : { ok: true };
  },
  register(epoch, onClose) {
    if (epoch === "stale") { onClose({ code: 4005, reason: "Signing you in again" }); return () => {}; }
    const entry = { epoch, onClose };
    streams.set(entry, true);
    return () => streams.delete(entry);
  },
};
function principal(req) {
  const h = req.headers, exp = h["x-test-exp"];
  const p = { workspace: h["x-test-files"] ? "files" : "full", access: "owner" };
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
        if (url.pathname === "/__test/streams") return res.end(JSON.stringify({ streams: streams.size }));
        if (!req.headers["x-test-person"]) { res.writeHead(401); return res.end("sign in"); }
        next(principal(req));
      },
      async upgrade(req, socket, head, next) {
        if (!req.headers["x-test-person"]) return socket.end("HTTP/1.1 401 Unauthorized\\r\\ncontent-length: 0\\r\\n\\r\\n");
        const p = principal(req);
        if (p.sessions && !(await p.sessions.check(p.session)).ok) return socket.end("HTTP/1.1 403 Forbidden\\r\\ncontent-length: 0\\r\\n\\r\\n");
        next(p);
      },
    },
  };
}`;

// The stand-in websockify: completes the handshake, records what reached it, then echoes bytes back.
async function fakeDesktop(t, { socketPath, port = 0, onOpen } = {}) {
  const seen = [],
    sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ http: req.url });
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ path: req.url, headers: req.headers });
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (onOpen) onOpen(socket);
    else socket.on("data", (d) => socket.write(d));
    socket.on("end", () => socket.destroy());
    socket.on("error", () => {});
  });
  await new Promise((r) =>
    socketPath ? server.listen(socketPath, r) : server.listen(port, "127.0.0.1", r),
  );
  if (socketPath) fs.chmodSync(socketPath, 0o600);
  t.after(
    () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  return { port: socketPath ? null : server.address().port, seen };
}

// A real Studio, with the test hook unless hooks: false. Waits for its port and a healthy /healthz.
async function boot(t, env, { hooks = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-desktop-"));
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
    if (port && (await get(port, "/healthz").catch(() => null))?.status === 200) break;
    await delay(40);
  }
  assert.ok(port, log);
  return { port, log: () => log };
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    r.on("error", reject);
    r.end();
  });
}
const ADA = { "x-test-person": "ada" };
const place = async (s, headers = ADA) =>
  JSON.parse((await get(s.port, "/api/studio/place", headers)).body).desktop;

// A raw upgrade: resolves { status, head, closed: Promise<ms>, bytes(), echo(text) }.
const upgrade = (
  port,
  { path: p = DESKTOP_PATH, origin = ORIGIN, host = "box.example.invalid", extra = ADA } = {},
) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const headers = {
      host,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "binary",
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
              s.write(Buffer.from(text, "latin1"));
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
  });
const closeFrame = (code, reason) =>
  Buffer.concat([
    Buffer.from([0x88, 2 + Buffer.byteLength(reason), code >> 8, code & 0xff]),
    Buffer.from(reason),
  ]);
const within = (p, ms) => Promise.race([p, delay(ms).then(() => null)]);

test("off without hooks: a loopback-only Studio offers no Desktop, even with STUDIO_DESKTOP_WS set", async (t) => {
  const d = await fakeDesktop(t);
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${d.port}` }, { hooks: false });
  assert.match(s.log(), /desktop off: only behind server hooks/);
  assert.doesNotMatch(s.log(), /desktop : /);
  assert.equal(await place(s, {}), null);
  const u = await upgrade(s.port, {
    host: `127.0.0.1:${s.port}`,
    origin: `http://127.0.0.1:${s.port}`,
  });
  assert.doesNotMatch(u.status, / 101 /, u.status);
  assert.equal(d.seen.length, 0, "nothing reached the desktop");
});

test("on with a hook: the admitted person reaches the desktop; only the handshake goes on, to the fixed target", async (t) => {
  const d = await fakeDesktop(t);
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${d.port}/websockify` });
  assert.match(s.log(), /desktop : \/desktop\/ws -> loopback port \d+, behind admission/);
  assert.equal(await place(s), DESKTOP_PATH);
  const u = await upgrade(s.port, {
    path: "/desktop/ws?host=10.0.0.1&port=22",
    extra: {
      ...ADA,
      cookie: "session=secret",
      authorization: "Bearer x",
      "x-forwarded-for": "1.2.3.4",
    },
  });
  assert.match(u.status, /^HTTP\/1\.1 101 /, u.head);
  assert.ok(await u.echo("bytes-through"), "frames reach the desktop and come back");
  u.socket.destroy();
  assert.equal(d.seen.length, 1);
  const r = d.seen[0];
  assert.equal(r.path, "/websockify", "the configured path; the client's query goes nowhere");
  for (const h of ["cookie", "authorization", "origin", "x-forwarded-for", "x-test-person"])
    assert.equal(r.headers[h], undefined, `${h} must not reach websockify`);
  assert.equal(r.headers["sec-websocket-protocol"], "binary", "subprotocols pass through");
  assert.equal(r.headers.host, `127.0.0.1:${d.port}`);
  // A reconnect is a new upgrade, admitted again, to the same target.
  const again = await upgrade(s.port);
  assert.match(again.status, /^HTTP\/1\.1 101 /);
  again.socket.destroy();
  assert.equal(d.seen.length, 2);
});

test("a foreign Origin, none, a lookalike, or no admission: refused, and nothing reaches the desktop", async (t) => {
  const d = await fakeDesktop(t);
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${d.port}` });
  for (const origin of ["https://evil.example", null, ORIGIN + ".evil.example"]) {
    const u = await upgrade(s.port, { origin });
    assert.match(u.status, /^HTTP\/1\.1 403 /, `${origin}: ${u.status}`);
    assert.match(u.head, /x-openrig-desktop: not this box's Studio/);
  }
  assert.match(
    (await upgrade(s.port, { extra: {} })).status,
    /^HTTP\/1\.1 401 /,
    "the hook refuses",
  );
  assert.equal(d.seen.length, 0);
  assert.match(s.log(), /desktop: refused at \S+ \(origin\)/);
  assert.doesNotMatch(s.log(), /evil\.example/, "the refusal line carries no values");
});

test("a files-only guest gets no Desktop: place says null and the upgrade is refused", async (t) => {
  const d = await fakeDesktop(t);
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${d.port}` });
  const files = { ...ADA, "x-test-files": "1" };
  assert.equal(await place(s, files), null);
  assert.match((await upgrade(s.port, { extra: files })).status, /^HTTP\/1\.1 403 /);
  assert.equal(d.seen.length, 0);
});

test("the sign-in's exp: none or past is refused; at exp the browser gets a close frame, 4001 'sign-in expired'", async (t) => {
  const d = await fakeDesktop(t);
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${d.port}` });
  const none = await upgrade(s.port, { extra: { ...ADA, "x-test-exp": "none" } });
  assert.match(none.status, /^HTTP\/1\.1 403 /);
  assert.match(none.head, /x-openrig-desktop: no sign-in expiry/);
  const past = await upgrade(s.port, { extra: { ...ADA, "x-test-exp": String(now() - 1) } });
  assert.match(past.status, /^HTTP\/1\.1 403 /);
  assert.match(past.head, /x-openrig-desktop: sign-in expired/);
  assert.equal(d.seen.length, 0);
  const u = await upgrade(s.port, { extra: { ...ADA, "x-test-exp": String(now() + 3) } });
  assert.match(u.status, /^HTTP\/1\.1 101 /);
  const ms = await within(u.closed, 8000);
  assert.ok(ms !== null && ms <= 5000, `ended at the sign-in's exp (after ${ms} ms)`);
  assert.deepEqual(u.bytes(), closeFrame(4001, "sign-in expired"));
  for (let i = 0; i < 50 && !/desktop: closed at/.test(s.log()); i++) await delay(100);
  assert.match(s.log(), /desktop: closed at \S+ \(sign-in expired\)/);
});

test("the person's session: a failed check or an ended session refuses; ending it later closes the tunnel and unregisters", async (t) => {
  const d = await fakeDesktop(t);
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${d.port}` });
  const as = (session) => ({ extra: { ...ADA, "x-test-session": session } });
  // The hook's own check at admission.
  assert.match((await upgrade(s.port, as("revoked"))).status, /^HTTP\/1\.1 403 /);
  // Registered, but the session has already moved on: refused before the upgrade, with the session's reason.
  const stale = await upgrade(s.port, as("stale"));
  assert.match(stale.status, /^HTTP\/1\.1 403 /);
  assert.match(stale.head, /x-openrig-desktop: Signing you in again/);
  assert.equal(d.seen.length, 0, "nothing reached the desktop");
  // Live: the session ends while the tunnel is open.
  const u = await upgrade(s.port, as("e1"));
  assert.match(u.status, /^HTTP\/1\.1 101 /);
  // A whole frame, so the close can follow it at once.
  assert.ok(await u.echo("\x82\x04live"));
  assert.equal(JSON.parse((await get(s.port, "/__test/streams")).body).streams, 1);
  assert.equal(JSON.parse((await get(s.port, "/__test/end?session=e1")).body).ended, 1);
  const ms = await within(u.closed, 5000);
  assert.ok(ms !== null, "closed when the session ended");
  assert.ok(
    u.bytes().includes(closeFrame(4003, "Your account signed out.")),
    "the session's code and reason",
  );
  await delay(100);
  assert.equal(JSON.parse((await get(s.port, "/__test/streams")).body).streams, 0, "unregistered");
});

test("TCP: place says null while nothing listens on the port, and the Desktop once something does", async (t) => {
  // A port that was free a moment ago; nothing listens on it when the Studio starts.
  const free = await new Promise((r) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => r(port));
    });
  });
  const s = await boot(t, { STUDIO_DESKTOP_WS: `ws://127.0.0.1:${free}` });
  assert.equal(await place(s), null, "nothing listening: not advertised");
  await fakeDesktop(t, { port: free });
  // The last answer is kept two seconds, so a page polling place doesn't open a connection per read.
  let seen = null;
  for (let i = 0; i < 40 && seen !== DESKTOP_PATH; i++) {
    seen = await place(s);
    if (seen !== DESKTOP_PATH) await delay(100);
  }
  assert.equal(seen, DESKTOP_PATH, "listening now: advertised");
});

test("desktopAnswering: one bounded connect, its answer kept, callers in flight share it", async () => {
  let clock = 0,
    connects = 0;
  const now = () => clock;
  // A stand-in connect that answers the way it is told to, when it is told to.
  const fake = (how) => () => {
    connects++;
    const handlers = {};
    const sock = {
      once: (ev, fn) => ((handlers[ev] = fn), sock),
      destroy: () => {},
    };
    if (how === "connect" || how === "error") setTimeout(() => handlers[how]?.(), 1);
    return sock;
  };
  const target = { host: "127.0.0.1", port: 1, path: "/" };
  const up = { now, connect: fake("connect"), ttlMs: 2000 };
  const [a, b] = await Promise.all([desktopAnswering(target, up), desktopAnswering(target, up)]);
  assert.deepEqual([a, b, connects], [true, true, 1], "two callers, one connect");
  clock = 1999;
  assert.equal(await desktopAnswering(target, { ...up, connect: fake("error") }), true, "kept");
  assert.equal(connects, 1);
  clock = 2000;
  assert.equal(
    await desktopAnswering(target, { ...up, connect: fake("error") }),
    false,
    "asked again",
  );
  assert.equal(connects, 2);
  const silent = { host: "127.0.0.1", port: 2, path: "/" };
  const started = Date.now();
  assert.equal(
    await desktopAnswering(silent, { now, connect: fake("never"), timeoutMs: 30 }),
    false,
  );
  assert.ok(Date.now() - started < 1000, "bounded by its timeout");
  const throwing = () => {
    throw new Error("no");
  };
  const once = { host: "x", port: 3 };
  assert.equal(await desktopAnswering(once, { now, connect: throwing }), false);
  clock += 5000;
  assert.equal(
    await desktopAnswering(once, { now, connect: fake("connect") }),
    true,
    "asked again",
  );
  assert.equal(await desktopAnswering(null), false);
  // A socket target is desktopReady's question: no connect at all.
  assert.equal(await desktopAnswering({ socketPath: "/nonexistent/rfb.sock", path: "/" }), false);
});

test("Unix socket: refused 503 'not ready' until it exists privately, then reachable; place follows", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sp = path.join(dir, "rfb.sock");
  const s = await boot(t, { STUDIO_DESKTOP_SOCKET: sp });
  assert.match(s.log(), /desktop : \/desktop\/ws -> the Unix socket /);
  assert.equal(await place(s), null, "missing");
  const miss = await upgrade(s.port);
  assert.match(miss.status, /^HTTP\/1\.1 503 /);
  assert.match(miss.head, /x-openrig-desktop: not ready/);
  const d = await fakeDesktop(t, { socketPath: sp });
  assert.equal(await place(s), DESKTOP_PATH, "created after the Studio started: ready now");
  fs.chmodSync(sp, 0o666);
  assert.equal(await place(s), null, "0666: anyone on the box could reach it");
  assert.match((await upgrade(s.port)).status, /^HTTP\/1\.1 503 /);
  fs.chmodSync(sp, 0o600);
  const ok = await upgrade(s.port);
  assert.match(ok.status, /^HTTP\/1\.1 101 /, "0600 again: ready");
  ok.socket.destroy();
  assert.equal(d.seen.length, 1, "only the ready upgrade reached it");
});

test("settings that turn the Desktop off, each with its reason", () => {
  assert.deepEqual(readDesktopTarget({}), { target: null, describe: null });
  for (const [env, why] of [
    [{ STUDIO_DESKTOP_WS: "wss://127.0.0.1:5901" }, /must be ws:\/\//],
    [{ STUDIO_DESKTOP_WS: "http://127.0.0.1:5901" }, /must be ws:\/\//],
    [{ STUDIO_DESKTOP_WS: "ws://10.0.0.1:5901" }, /loopback/],
    [{ STUDIO_DESKTOP_WS: "ws://desktop.example:5901" }, /loopback/],
    [{ STUDIO_DESKTOP_WS: "ws://127.0.0.1" }, /needs a port/],
    [{ STUDIO_DESKTOP_WS: "ws://u:p@127.0.0.1:5901" }, /credentials/],
    [{ STUDIO_DESKTOP_WS: "ws://127.0.0.1:5901/?x=1" }, /query/],
    [{ STUDIO_DESKTOP_WS: "not a url" }, /isn't a URL/],
    [{ STUDIO_DESKTOP_SOCKET: "rfb.sock" }, /absolute, normalised/],
    [{ STUDIO_DESKTOP_SOCKET: "/tmp/../tmp/rfb.sock" }, /absolute, normalised/],
    [{ STUDIO_DESKTOP_SOCKET: "/" + "a".repeat(120) }, /too long/],
    [
      { STUDIO_DESKTOP_SOCKET: "/tmp/rfb.sock", STUDIO_DESKTOP_WS: "ws://127.0.0.1:5901" },
      /not both/,
    ],
  ]) {
    const r = readDesktopTarget(env);
    assert.equal(r.target, null, JSON.stringify(env));
    assert.match(r.describe, why, JSON.stringify(env));
  }
  assert.deepEqual(readDesktopTarget({ STUDIO_DESKTOP_WS: "ws://[::1]:5901/w" }).target, {
    host: "::1",
    port: 5901,
    path: "/w",
  });
});

test("frame boundaries: headers of every length are read, payloads only counted", () => {
  const frame = (len) => {
    const h = Buffer.from([
      0x82,
      len < 126 ? len : len < 65536 ? 126 : 127,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    if (len >= 65536) h.writeBigUInt64BE(BigInt(len), 2);
    else if (len >= 126) h.writeUInt16BE(len, 2);
    return Buffer.concat([
      h.subarray(0, len < 126 ? 2 : len < 65536 ? 4 : 10),
      Buffer.alloc(len, 7),
    ]);
  };
  const seen = [];
  const f = frameTracker((b0) => seen.push(b0));
  const stream = Buffer.concat([frame(5), frame(300), frame(70000)]);
  // Fed in awkward pieces, the tracker is at a boundary exactly between frames.
  for (let i = 0; i < stream.length; i += 997) f.consume(stream.subarray(i, i + 997));
  assert.equal(f.atBoundary(), true);
  assert.deepEqual(seen, [0x82, 0x82, 0x82]);
  const g = frameTracker();
  const two = Buffer.concat([frame(3), frame(4)]);
  assert.equal(g.consume(two.subarray(0, 3)), -1, "inside the first frame");
  assert.equal(g.consume(two.subarray(3), true), 2, "the boundary falls two bytes into the rest");
});
