import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTerminals } from "../tools/terminal.mjs";
import { teamClient } from "../tools/herdr-client.mjs";
async function fixture(t, options) {
  const root = fs.mkdtempSync("/tmp/studio-tty-"),
    file = path.join(root, "tty.sock"),
    seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.end("<h1>Owned terminal fixture</h1>");
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]));
    socket.on("error", () => {});
    socket.on("end", () => socket.destroy());
  });
  await new Promise((r) => upstream.listen(file, r));
  fs.chmodSync(file, 0o600);
  const env = { STUDIO_TERMINAL_SOCKET: file, STUDIO_TEAM_SOCKET: file };
  const terminals = createTerminals(env, options);
  const server = http.createServer((req, res) => {
    if (!terminals.request(req, res)) res.end("other");
  });
  server.on("upgrade", (req, socket, head) => {
    if (!terminals.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    terminals.close();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    env,
    terminals,
    seen,
    base: "http://127.0.0.1:" + server.address().port,
    port: server.address().port,
  };
}
test("shell and full team use fixed private listeners, without browser-selected commands or credentials", async (t) => {
  const f = await fixture(t);
  for (const prefix of ["/terminal/", "/team/"]) {
    const r = await fetch(f.base + prefix, {
      headers: { authorization: "Bearer inert", cookie: "inert=fixture" },
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Owned terminal/);
    assert.equal(f.seen.at(-1).headers.authorization, undefined);
    assert.equal(f.seen.at(-1).headers.cookie, undefined);
  }
  // Every answer may be framed only by this Studio's own pages: the page, and a refusal too.
  for (const r of [await fetch(f.base + "/terminal/"), await fetch(f.base + "/team/?arg=other")]) {
    assert.equal(r.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  }
  assert.equal(f.terminals.place().team.path, "/team/");
  assert.equal((await fetch(f.base + "/team/?arg=other")).status, 400);
  fs.chmodSync(f.file, 0o660);
  assert.equal(f.terminals.place().team.state, "unavailable");
  assert.equal((await fetch(f.base + "/team/")).status, 503);
  assert.equal(createTerminals({}).place().team.state, "not-configured");
  // A local Studio without ttyd says to install it (it starts its own shell), rather than to run a listener by hand.
  assert.match(
    createTerminals({}, { shellMissing: true }).place().terminal.reason,
    /ttyd isn't installed/,
  );
  assert.match(createTerminals({}).place().terminal.reason, /Set STUDIO_TERMINAL_SOCKET/);
  assert.doesNotMatch(
    createTerminals({}, { shellMissing: true }).place().team.reason,
    /ttyd isn't installed/,
  );
});
test("the full team WebSocket carries its actual upstream data and refuses a different browser origin", async (t) => {
  const f = await fixture(t);
  const connect = (origin) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(f.port, "127.0.0.1");
      let bytes = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Error("fixture handshake timed out"));
      }, 2500);
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(
          `GET /team/ws HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        ),
      );
      socket.on("data", (b) => {
        bytes = Buffer.concat([bytes, b]);
        if (bytes.includes(Buffer.from("hello")) || bytes.includes(Buffer.from("403 Forbidden"))) {
          clearTimeout(timer);
          socket.destroy();
          resolve(bytes.toString());
        }
      });
    });
  assert.match(await connect(f.base), /101 Switching Protocols[\s\S]*hello/);
  const n = f.seen.length;
  assert.match(await connect("http://elsewhere.invalid"), /403 Forbidden/);
  // A sandboxed frame (a stored artifact, say) has an opaque origin, sent as "null": never this Studio.
  assert.match(await connect("null"), /403 Forbidden/);
  assert.equal(f.seen.length, n);
});
test("the terminal takes the loopback gate's allowed origins (STUDIO_ALLOWED_ORIGINS), and not the hosted SIGNIN_ORIGINS", async (t) => {
  const handshake = (port, origin) =>
    new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let got = "";
      socket.on("connect", () =>
        socket.write(
          `GET /team/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        ),
      );
      socket.on("data", (b) => {
        got += b;
        if (got.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(got.split("\r\n")[0]);
        }
      });
      socket.on("error", () => resolve("closed"));
    });
  const f = await fixture(t, { allowedOrigins: new Set(["http://ui.example.test"]) });
  assert.match(await handshake(f.port, "http://ui.example.test"), /101/);
  assert.match(await handshake(f.port, "null"), /403/);
  // Read from the environment when not passed: the same variable the gate reads.
  const env = {
    ...f.env,
    STUDIO_ALLOWED_ORIGINS: "http://ui2.example.test",
    SIGNIN_ORIGINS: "http://signin.example.test",
  };
  const fromEnv = createTerminals(env);
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    if (!fromEnv.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    fromEnv.close();
    server.close();
  });
  const port = server.address().port;
  assert.match(await handshake(port, "http://ui2.example.test"), /101/);
  assert.match(await handshake(port, "http://signin.example.test"), /403/);
});
test("the maintained full Herdr client attaches the selected existing session, independently of Core version", async (t) => {
  const f = await fixture(t),
    bin = path.join(f.root, "herdr");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = {
    HOME: f.root,
    STUDIO_HERDR_BIN: bin,
    STUDIO_HERDR_SHA256: createHash("sha256").update(fs.readFileSync(bin)).digest("hex"),
    HERDR_SOCKET_PATH: f.file,
    STUDIO_HERDR_SESSION: "existing-team",
    OPENRIG_AUTH_BEARER_TOKEN: "inert-not-forwarded",
  };
  const c = teamClient(env);
  assert.deepEqual(c.args, ["session", "attach", "existing-team"]);
  assert.equal(c.env.OPENRIG_AUTH_BEARER_TOKEN, undefined);
  assert.equal(c.env.HERDR_SOCKET_PATH, f.file);
  assert.throws(
    () => teamClient({ ...env, STUDIO_HERDR_SHA256: "0".repeat(64) }),
    /pinned version/,
  );
});
test("the launcher runs only its selected fixed ttyd command; team mode has no open/create operation", async (t) => {
  const f = await fixture(t),
    ttyd = path.join(f.root, "ttyd"),
    log = path.join(f.root, "args");
  // The fake ttyd sets 0660 like the real one, which does it as it binds. Node
  // can only chmod after listen, so it binds beside the path and renames the
  // socket into place already 0660; otherwise its chmod could land after the
  // launcher has already reported ready.
  fs.writeFileSync(
    ttyd,
    "#!" +
      process.execPath +
      '\nimport fs from"node:fs";import http from"node:http";const a=process.argv.slice(2);fs.writeFileSync(process.env.FIXTURE_LOG,a.join("\\n"));const p=a[a.indexOf("-i")+1];process.stderr.write("[t] W: callback_lws_sshd_demo: no key\\n[t] E: a real error\\nttyd: a line of its own\\n");const s=http.createServer((q,r)=>r.end("inert"));s.listen(p+".bind",()=>{fs.chmodSync(p+".bind",0o660);fs.renameSync(p+".bind",p)});process.on("SIGTERM",()=>s.close(()=>process.exit(0)));\n',
    { mode: 0o700 },
  );
  const bin = path.join(f.root, "herdr");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = {
    HOME: f.root,
    PATH: "/usr/bin:/bin",
    FIXTURE_LOG: log,
    STUDIO_TTYD_BIN: ttyd,
    STUDIO_TERMINAL_SOCKET: path.join(f.root, "shell.sock"),
    STUDIO_TEAM_SOCKET: path.join(f.root, "team.sock"),
    STUDIO_HERDR_BIN: bin,
    STUDIO_HERDR_SHA256: createHash("sha256").update(fs.readFileSync(bin)).digest("hex"),
    HERDR_SOCKET_PATH: f.file,
    STUDIO_HERDR_SESSION: "already-existing",
  };
  const launcher = fileURLToPath(new URL("../tools/start-terminal.mjs", import.meta.url));
  for (const mode of ["shell", "team"]) {
    const c = spawn(process.execPath, [launcher, mode], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    c.stdout.on("data", (b) => (output += b));
    c.stderr.on("data", (b) => (output += b));
    const exit = new Promise((r) => c.once("exit", r));
    t.after(() => {
      if (c.exitCode === null) c.kill("SIGTERM");
    });
    for (let i = 0; i < 150 && !output.includes("Terminal ready:"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.match(output, /Terminal ready:/);
    // ttyd's errors and its own lines reach the log; libwebsockets' plugin warnings don't.
    for (let i = 0; i < 100 && !output.includes("a line of its own"); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.match(output, /\[t\] E: a real error\n/);
    assert.match(output, /ttyd: a line of its own\n/);
    assert.doesNotMatch(output, /W: callback_lws_sshd_demo/);
    assert.equal(
      fs.statSync(env[mode === "shell" ? "STUDIO_TERMINAL_SOCKET" : "STUDIO_TEAM_SOCKET"]).mode &
        0o777,
      0o600,
    );
    const args = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(args.slice(0, 9), [
      "-p",
      "0",
      "-i",
      env[mode === "shell" ? "STUDIO_TERMINAL_SOCKET" : "STUDIO_TEAM_SOCKET"],
      "-b",
      mode === "shell" ? "/terminal" : "/team",
      "-W",
      "-d",
      "1",
    ]);
    if (mode === "team")
      assert.deepEqual(args.slice(9), [
        process.execPath,
        fileURLToPath(new URL("../tools/herdr-client.mjs", import.meta.url)),
      ]);
    else assert.deepEqual(args.slice(9), ["/bin/sh", "-l"]);
    c.kill("SIGTERM");
    await exit;
  }
});

test("a too-long Unix socket is refused before the ttyd command runs", (t) => {
  const root = fs.mkdtempSync("/tmp/studio-long-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../tools/start-terminal.mjs", import.meta.url)), "shell"],
    {
      env: {
        STUDIO_TERMINAL_SOCKET: root + "/" + "x".repeat(120),
        STUDIO_TTYD_BIN: "/not-a-real-command",
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /at most 100 bytes/);
  assert.doesNotMatch(r.stderr, /Could not start ttyd/);
});

test("a ttyd process that never binds its Unix socket is stopped and never reports ready", (t) => {
  const root = fs.mkdtempSync("/tmp/studio-never-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "ttyd"),
    pid = path.join(root, "pid");
  fs.writeFileSync(
    bin,
    "#!" +
      process.execPath +
      '\nimport fs from"node:fs";fs.writeFileSync(process.env.FIXTURE_PID,String(process.pid));setInterval(()=>{},1000);\n',
    { mode: 0o700 },
  );
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../tools/start-terminal.mjs", import.meta.url)), "shell"],
    {
      env: {
        STUDIO_TERMINAL_SOCKET: path.join(root, "tty.sock"),
        STUDIO_TTYD_BIN: bin,
        FIXTURE_PID: pid,
      },
      encoding: "utf8",
      timeout: 8000,
    },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /within 5 seconds/);
  assert.doesNotMatch(r.stdout, /Terminal ready/);
  assert.throws(() => process.kill(Number(fs.readFileSync(pid, "utf8")), 0), /ESRCH/);
});
