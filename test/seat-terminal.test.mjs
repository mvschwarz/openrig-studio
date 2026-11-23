// The seat terminals at /chat (tools/seat-terminal.mjs, mounted in tools/studio.mjs): ttyd on a Unix socket in a 0700
// folder the Studio owns, never a TCP port; the frame rule on every /chat answer; and the WebSocket closed at the
// principal's exp and when its session ends, or held to this Studio's own Origin on the loopback default.
//
// No real ttyd, rig or seat is used: a stand-in ttyd on PATH serves a page and echoes WebSocket bytes on the socket it
// is given with -i, and the roster is a declared one.
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
  CHAT_FRAMING,
  createSeatSocket,
  sameStudioOrigin,
  upgradeChat,
} from "../tools/seat-terminal.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://box.example.invalid";
const delay = (n) => new Promise((r) => setTimeout(r, n));
const now = () => Math.floor(Date.now() / 1000);
const scratch = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const accept = (key) =>
  crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

// A WebSocket service on a Unix socket: 101, then it echoes. Left at `mode`, as ttyd leaves its own socket (0660).
async function echoService(t, socketPath, mode = 0o600) {
  const open = new Set();
  const server = http.createServer((req, res) => res.end("page"));
  server.on("upgrade", (req, socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept(req.headers["sec-websocket-key"])}\r\n\r\n`,
    );
    socket.on("data", (d) => socket.write(d));
    socket.on("end", () => socket.destroy());
  });
  await new Promise((r) => server.listen(socketPath, r));
  fs.chmodSync(socketPath, mode);
  t.after(
    () =>
      new Promise((r) => {
        for (const s of open) s.destroy();
        server.close(r);
      }),
  );
}

// One raw WebSocket client over a socket pair the test drives: `serve(socket)` gets the server side, as Node's upgrade
// event would. Resolves with what the browser side received once it closes.
function browserPair(t) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const browser = net.connect(srv.address().port, "127.0.0.1");
      srv.once("connection", (server) => {
        srv.close();
        let got = Buffer.alloc(0);
        browser.on("data", (d) => (got = Buffer.concat([got, d])));
        browser.on("error", () => {});
        const closed = new Promise((r) => browser.on("close", () => r(got)));
        t.after(() => {
          browser.destroy();
          server.destroy();
        });
        resolve({ browser, server, got: () => got, closed });
      });
    });
  });
}
const wsReq = (url, headers = {}) => ({
  url,
  method: "GET",
  headers: {
    host: "127.0.0.1:8890",
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
    "sec-websocket-version": "13",
    ...headers,
  },
});
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) return false;
    await delay(20);
  }
  return true;
};
// A masked client frame (RFC 6455): FIN + binary, mask bit, a 4-byte mask.
const clientFrame = (bytes) => {
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(bytes).map((b, i) => b ^ mask[i % 4]);
  return Buffer.concat([Buffer.from([0x82, 0x80 | body.length]), mask, body]);
};

test("the seat socket: a fresh 0700 folder of this user's, a short path, tightened to 0600, removed on close", async (t) => {
  const seat = createSeatSocket();
  assert.ok(seat.socket, seat.reason);
  const st = fs.statSync(seat.dir);
  assert.equal(st.mode & 0o777, 0o700);
  assert.equal(st.uid, process.getuid());
  assert.ok(Buffer.byteLength(seat.socket) <= 100);
  // ttyd leaves its socket 0660; the folder's watcher (or the next connection) makes it 0600. A directory watch reports
  // entries coming and going, not a change to an entry's mode, so the socket's own creation event can arrive before the
  // chmod that follows it. Any later change in the folder tightens it; one is made here so the check doesn't hang on
  // that ordering.
  await echoService(t, seat.socket, 0o660);
  const marker = path.join(seat.dir, "changed");
  fs.writeFileSync(marker, "");
  fs.rmSync(marker);
  assert.ok(
    await until(() => (fs.statSync(seat.socket).mode & 0o777) === 0o600),
    "tightened by the watcher",
  );
  fs.chmodSync(seat.socket, 0o660);
  seat.tighten();
  assert.equal(fs.statSync(seat.socket).mode & 0o777, 0o600);
  seat.close();
  assert.equal(fs.existsSync(seat.dir), false);
  // A temp folder whose path can't hold a Unix socket gets no seat terminals at all.
  const deep = scratch(t, "seat-deep-");
  const long = path.join(deep, "x".repeat(90));
  fs.mkdirSync(long);
  const none = createSeatSocket({ tmpdir: long });
  assert.equal(none.socket, null);
  assert.match(none.reason, /too long/);
  assert.deepEqual(fs.readdirSync(long), [], "nothing left behind");
});

test("the frame rule is this origin only; the loopback Origin rule is this Studio's own address or a box origin", () => {
  assert.deepEqual(CHAT_FRAMING, { "content-security-policy": "frame-ancestors 'self'" });
  const origins = new Set([ORIGIN]);
  const r = (origin, host = "127.0.0.1:8890") => ({ headers: { origin, host } });
  assert.equal(sameStudioOrigin(r("http://127.0.0.1:8890"), origins), true);
  assert.equal(sameStudioOrigin(r("https://studio.example", "studio.example"), origins), true);
  assert.equal(sameStudioOrigin(r(ORIGIN, "anything"), origins), true);
  assert.equal(sameStudioOrigin(r("https://evil.example"), origins), false);
  assert.equal(sameStudioOrigin(r("http://127.0.0.1:8891"), origins), false);
  assert.equal(sameStudioOrigin(r(undefined), origins), false);
});

test("loopback /chat WebSocket: this Studio's own Origin is tunnelled; another site's, none, or a socket left open to others is refused", async (t) => {
  const dir = scratch(t, "seat-up-");
  const sock = path.join(dir, "t.sock");
  await echoService(t, sock);
  const origins = new Set();
  const run = async (headers) => {
    const p = await browserPair(t);
    upgradeChat(wsReq("/chat/ws?arg=one%40declared", headers), p.server, Buffer.alloc(0), {
      socketPath: sock,
      principal: { workspace: "full", access: "owner" },
      origins,
    });
    return p;
  };
  const ok = await run({ origin: "http://127.0.0.1:8890" });
  assert.ok(await until(() => ok.got().includes("101 Switching")), ok.got().toString());
  ok.browser.write(clientFrame("hi"));
  assert.ok(await until(() => ok.got().includes(Buffer.from([0x82, 0x80 | 2]))), "bytes flow");
  for (const [why, headers] of [
    ["another site", { origin: "https://evil.example" }],
    ["no Origin", {}],
  ]) {
    const p = await run(headers);
    const got = (await p.closed).toString();
    assert.match(got, /^HTTP\/1\.1 403 /, why);
    assert.match(got, /x-openrig-chat: not this Studio/, why);
  }
  fs.chmodSync(sock, 0o660);
  const open = await run({ origin: "http://127.0.0.1:8890" });
  assert.match(
    (await open.closed).toString(),
    /^HTTP\/1\.1 503 /,
    "a socket others can reach isn't used",
  );
});

test("behind hooks, /chat closes at the principal's exp and when its session ends; sessions without exp are refused", async (t) => {
  const dir = scratch(t, "seat-up-");
  const sock = path.join(dir, "t.sock");
  await echoService(t, sock);
  const origins = new Set([ORIGIN]);
  const lines = [];
  const run = async (principal, headers = { origin: ORIGIN }) => {
    const p = await browserPair(t);
    upgradeChat(wsReq("/chat/ws?arg=one%40declared", headers), p.server, Buffer.alloc(0), {
      socketPath: sock,
      principal,
      origins,
      log: (l) => lines.push(l),
    });
    return p;
  };
  // At exp: close code 4001 "sign-in expired".
  const expiring = await run({ workspace: "full", access: "owner", exp: now() + 2 });
  assert.ok(await until(() => expiring.got().includes("101 Switching")));
  const expired = await expiring.closed;
  assert.ok(expired.includes(Buffer.from([0x88, 17, 0x0f, 0xa1])), "4001 at exp");
  assert.ok(
    await until(() => lines.some((l) => /^chat: closed at .* \(sign-in expired\)$/.test(l))),
    lines.join("\n"),
  );
  // When the session ends: its own code and reason.
  let end = null;
  let unregistered = 0;
  const sessions = {
    check: async () => ({ ok: true }),
    register(epoch, onClose) {
      assert.equal(epoch, "epoch-a");
      end = onClose;
      return () => unregistered++;
    },
  };
  const live = await run({ workspace: "full", exp: now() + 3600, session: "epoch-a", sessions });
  assert.ok(await until(() => live.got().includes("101 Switching")));
  end({ code: 4003, reason: "Signed out." });
  const ended = await live.closed;
  assert.ok(ended.includes(Buffer.from([0x88, 13, 0x0f, 0xa3])), "4003 when the session ends");
  assert.ok(await until(() => unregistered === 1), "unregistered when it closed");
  // Without exp, a tunnel that can't be bounded isn't opened; another site's Origin isn't either.
  const unbounded = await run({ workspace: "full", session: "epoch-a", sessions });
  assert.match(
    (await unbounded.closed).toString(),
    /^HTTP\/1\.1 403 .*\r\nx-openrig-chat: no sign-in expiry/s,
  );
  const foreign = await run(
    { workspace: "full", exp: now() + 60 },
    { origin: "https://evil.example" },
  );
  assert.match((await foreign.closed).toString(), /^HTTP\/1\.1 403 /);
});

// ---- a real Studio ----------------------------------------------------------

// A stand-in ttyd: --version, and otherwise its page and an echoing WebSocket on the socket given with -i, left 0660 as
// ttyd leaves it. The seat terminal's (-b /chat) writes its arguments and socket where FAKE_TTYD_RECORD says; the local
// shell terminal the Studio also starts with this ttyd (-b /terminal) doesn't, so the two can't overwrite each other.
const FAKE_TTYD = `#!${process.execPath}
const fs = require("node:fs"), http = require("node:http"), crypto = require("node:crypto");
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("ttyd 1.7.7"); process.exit(0); }
const p = a[a.indexOf("-i") + 1];
process.stderr.write("[t] W: handler_server_protocol_init: requires 'upload-dir' pvo\\n[t] E: seat ttyd error line\\n");
if (a[a.indexOf("-b") + 1] === "/chat") fs.writeFileSync(process.env.FAKE_TTYD_RECORD, JSON.stringify({ args: a, socket: p }));
const s = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end("<!doctype html><head><title>ttyd</title></head><p>seat page</p>"); });
s.on("upgrade", (q, c) => {
  const k = crypto.createHash("sha1").update(q.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  c.write("HTTP/1.1 101 Switching Protocols\\r\\nupgrade: websocket\\r\\nconnection: Upgrade\\r\\nsec-websocket-accept: " + k + "\\r\\n\\r\\n");
  c.on("data", (d) => c.write(d)); c.on("error", () => {}); c.on("end", () => c.destroy());
});
s.listen(p, () => fs.chmodSync(p, 0o660));
process.on("SIGTERM", () => process.exit(0));
`;

// The test hook admits a request that carries x-test-person, with a session registered with its own `sessions`; its
// path /__test/end ends every session.
const HOOK = `
const streams = new Set();
const sessions = { check: async () => ({ ok: true }), register(epoch, onClose) { const e = { onClose }; streams.add(e); return () => streams.delete(e); } };
const principal = () => ({ workspace: "full", access: "owner", email: "ada@example.com", exp: Math.floor(Date.now() / 1000) + 3600, session: "e1", sessions });
export default function install() {
  return {
    describe: "test door",
    admission: {
      http(req, res, next) {
        if (req.url === "/__test/end") { for (const e of streams) e.onClose({ code: 4003, reason: "Signed out." }); return res.end("ended"); }
        if (!req.headers["x-test-person"]) { res.writeHead(401); return res.end(); }
        next(principal());
      },
      upgrade(req, socket, head, next) {
        if (!req.headers["x-test-person"]) return socket.end("HTTP/1.1 401 Unauthorized\\r\\ncontent-length: 0\\r\\n\\r\\n");
        next(principal());
      },
    },
  };
}`;

function fixture(t) {
  const root = scratch(t, "seat-studio-");
  const studio = path.join(root, "studio");
  const bin = path.join(root, "bin");
  const record = path.join(root, "ttyd.json");
  fs.mkdirSync(studio);
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "ttyd"), FAKE_TTYD, { mode: 0o700 });
  fs.writeFileSync(
    path.join(studio, "surfaces.json"),
    JSON.stringify({ chatSeats: [{ seat: "one@declared", name: "one" }] }),
  );
  fs.writeFileSync(path.join(studio, "door.mjs"), HOOK);
  const kids = [];
  t.after(async () => {
    for (const c of kids) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
    await delay(300);
    for (const c of kids) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
  });
  return {
    record: () => JSON.parse(fs.readFileSync(record, "utf8")),
    hasRecord: () => fs.existsSync(record),
    async start(cfg = {}, env = {}) {
      fs.writeFileSync(
        path.join(studio, "studio.json"),
        JSON.stringify({ port: 0, rig: false, ...cfg }),
      );
      const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          OPENRIG_STUDIO_DIR: studio,
          FAKE_TTYD_RECORD: record,
          ...env,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      kids.push(c);
      let log = "";
      let port = null;
      c.stdout.on("data", (b) => {
        log += b;
        port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
      });
      c.stderr.on("data", (b) => (log += b));
      const exited = new Promise((r) => c.once("exit", r));
      for (let i = 0; i < 200; i++) {
        if (c.exitCode !== null) throw Error(log);
        // Ready once ttyd's socket is tightened AND every child answers (/healthz is never gated): the launcher prints
        // its address before the runtime behind it is serving /surfaces.json.
        if (port && fs.existsSync(record)) {
          const sock = JSON.parse(fs.readFileSync(record, "utf8")).socket;
          if (
            fs.existsSync(sock) &&
            (fs.statSync(sock).mode & 0o777) === 0o600 &&
            (await get(port, "/healthz").catch(() => ({}))).status === 200
          )
            break;
        }
        await delay(50);
      }
      return { port, log: () => log, proc: c, exited };
    },
  };
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });
}
// A raw upgrade to the Studio; resolves with the client socket and what it has received.
function connect(t, port, p, headers) {
  const s = net.connect(port, "127.0.0.1");
  let got = Buffer.alloc(0);
  const closed = new Promise((r) => s.on("close", () => r(got)));
  s.on("data", (d) => (got = Buffer.concat([got, d])));
  s.on("error", () => {});
  s.on("connect", () =>
    s.write(
      `GET ${p} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: ${crypto.randomBytes(16).toString("base64")}\r\nsec-websocket-version: 13\r\n${Object.entries(
        headers,
      )
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("")}\r\n`,
    ),
  );
  t.after(() => s.destroy());
  return { socket: s, got: () => got, closed };
}

test("a local Studio: ttyd on a private Unix socket (no TCP port), the page framed by this origin only, its own Origin tunnelled", async (t) => {
  const f = fixture(t);
  const s = await f.start();
  assert.ok(s.port, s.log());
  const { args, socket } = f.record();
  // The socket, not a port: -i <socket> in a 0700 folder this user owns, the socket 0600, and no -p.
  assert.deepEqual(args.slice(0, 8), ["-W", "-a", "-i", socket, "-b", "/chat", "-d", "1"]);
  assert.ok(!args.includes("-p"), args.join(" "));
  const folder = fs.statSync(path.dirname(socket));
  assert.equal(folder.mode & 0o777, 0o700);
  assert.equal(folder.uid, process.getuid());
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  assert.match(
    s.log(),
    /terminal: seats attachable through \/chat \(ttyd on a Unix socket, this user only\)/,
  );
  // The seat ttyd's errors reach the boot log; libwebsockets' plugin warnings don't.
  assert.match(s.log(), /\[t\] E: seat ttyd error line/);
  assert.doesNotMatch(s.log(), /W: handler_server_protocol_init/);
  // The manifest still says the roster is attachable, and nothing listens on the reserved seat port.
  const manifest = JSON.parse((await get(s.port, "/surfaces.json")).body);
  assert.ok(manifest.chatLocalPort, "attachable");
  const tcp = await new Promise((r) => {
    const c = net.connect(manifest.chatLocalPort, "127.0.0.1");
    c.once("connect", () => (c.destroy(), r("open")));
    c.once("error", () => r("refused"));
  });
  assert.equal(tcp, "refused", "no TCP listener behind /chat");
  // The page: from the socket, with the clipboard shim spliced in, framed only by this origin.
  const page = await get(s.port, "/chat/?arg=one%40declared");
  assert.equal(page.status, 200);
  assert.match(page.body, /seat page/);
  assert.match(page.body, /OSC-52 clipboard shim/);
  assert.equal(page.headers["content-security-policy"], "frame-ancestors 'self'");
  // The WebSocket: this Studio's own Origin goes through; another site's doesn't.
  const own = connect(t, s.port, "/chat/ws?arg=one%40declared", {
    origin: `http://127.0.0.1:${s.port}`,
  });
  assert.ok(await until(() => own.got().includes("101 Switching")), own.got().toString());
  const other = connect(t, s.port, "/chat/ws?arg=one%40declared", {
    origin: "https://evil.example",
  });
  assert.match((await other.closed).toString(), /^HTTP\/1\.1 403 /);
  // A clean stop removes the socket's folder.
  s.proc.kill("SIGTERM");
  await s.exited;
  assert.ok(await until(() => !fs.existsSync(path.dirname(socket))), "the folder is gone");
});

test("behind hooks: an open /chat socket closes when the person's session ends", async (t) => {
  const f = fixture(t);
  const s = await f.start({ serverHooks: "door.mjs" }, { SIGNIN_ORIGINS: ORIGIN });
  assert.ok(s.port, s.log());
  const who = { "x-test-person": "ada" };
  const page = await get(s.port, "/chat/?arg=one%40declared", who);
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-security-policy"], "frame-ancestors 'self'");
  const c = connect(t, s.port, "/chat/ws?arg=one%40declared", { ...who, origin: ORIGIN });
  assert.ok(await until(() => c.got().includes("101 Switching")), c.got().toString());
  assert.equal((await get(s.port, "/__test/end", who)).body, "ended");
  const got = await c.closed;
  assert.ok(got.includes(Buffer.from([0x88, 13, 0x0f, 0xa3])), "4003 when the session ends");
  assert.ok(await until(() => /chat: closed at .* \(Signed out\.\)/.test(s.log())), s.log());
  // Another site's Origin is refused before ttyd is asked.
  const other = connect(t, s.port, "/chat/ws?arg=one%40declared", {
    ...who,
    origin: "https://evil.example",
  });
  assert.match((await other.closed).toString(), /^HTTP\/1\.1 403 /);
});
