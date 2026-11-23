import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import {
  isHealth,
  isLoopbackHost,
  allowedHostsFrom,
  allowedOriginsFrom,
  fromOwnPages,
  isOwnOrigin,
  loopbackAdmission,
  writeAllowed,
  checkHooks,
  healthDetailAllowed,
  loadServerHooks,
  notifyHealth,
} from "../tools/server-hooks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const delay = (n) => new Promise((r) => setTimeout(r, n));
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
};
const req = (h) => ({ headers: { host: h } });

test("loopback Host: only this computer's names on the Studio's own port", () => {
  const ports = () => [8890];
  assert.equal(isLoopbackHost(req("127.0.0.1:8890"), ports), true);
  assert.equal(isLoopbackHost(req("localhost:8890"), ports), true);
  assert.equal(isLoopbackHost(req("[::1]:8890"), ports), true);
  assert.equal(isLoopbackHost(req("127.0.0.1:8891"), ports), false);
  assert.equal(isLoopbackHost(req("evil.example:8890"), ports), false);
  assert.equal(isLoopbackHost(req("user@127.0.0.1:8890"), ports), false);
  assert.equal(isLoopbackHost(req(""), ports), false);
  assert.equal(isLoopbackHost({ headers: {} }, ports), false);
  assert.equal(isLoopbackHost(req("studio.example.net"), ports, ["studio.example.net"]), true);
});

test("allowed hosts are read from the environment, malformed entries dropped", () => {
  assert.deepEqual(allowedHostsFrom({ STUDIO_ALLOWED_HOSTS: " A.example:9000 ,bad host,,x/y" }), [
    "a.example:9000",
  ]);
  assert.deepEqual(allowedHostsFrom({}), []);
});

test("allowed origins: exact http(s) origins from STUDIO_ALLOWED_ORIGINS, anything else dropped", () => {
  assert.deepEqual(
    [
      ...allowedOriginsFrom({
        STUDIO_ALLOWED_ORIGINS:
          " http://127.0.0.1:7433 ,https://ui.example.test/,http://x.test/path,null,ftp://x.test,,not a url",
      }),
    ],
    ["http://127.0.0.1:7433", "https://ui.example.test"],
  );
  assert.equal(allowedOriginsFrom({}).size, 0);
});

// One request as the gate sees it.
const at = (method, headers) => ({ method, headers: { host: "127.0.0.1:8890", ...headers } });

test("the Origin rule: changes and upgrades come from this Studio's own pages, or an allowed origin", () => {
  const allowed = new Set(["http://ui.example.test"]);
  const own = "http://127.0.0.1:8890";
  // This Studio's own address, over http or https, is its own page; "null" and other ports, names and sites aren't.
  assert.equal(isOwnOrigin(at("POST", { origin: own })), true);
  assert.equal(isOwnOrigin(at("POST", { origin: "https://127.0.0.1:8890" })), true);
  for (const origin of [
    "null",
    "http://127.0.0.1:9000",
    "http://localhost:8890",
    "http://evil.example",
    "",
  ])
    assert.equal(isOwnOrigin(at("POST", { origin })), false, origin);
  assert.equal(isOwnOrigin(at("POST", { origin: "http://ui.example.test" }), allowed), true);

  // Reads never need an Origin: the Host rule is enough, and a page can't read another origin's answer.
  for (const method of ["GET", "HEAD", "OPTIONS"])
    assert.equal(
      writeAllowed(at(method, { origin: "http://evil.example", "sec-fetch-site": "cross-site" })),
      true,
      method,
    );
  // Changes: refused from another site, by Origin or by Sec-Fetch-Site.
  const refused = [
    { origin: "http://evil.example" },
    { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "cross-site" },
    // Another port on 127.0.0.1 is the same SITE (any local dev server): no better than another site.
    { "sec-fetch-site": "same-site" },
    { origin: "http://127.0.0.1:9000", "sec-fetch-site": "same-site" },
    // A sandboxed frame or a cross-site redirect.
    { origin: "null" },
    // A page can't claim this Studio's origin while the browser says another site sent it.
    { origin: own, "sec-fetch-site": "cross-site" },
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    for (const h of refused)
      assert.equal(writeAllowed(at(method, h), allowed), false, `${method} ${JSON.stringify(h)}`);
  // Allowed: the Studio's own pages, an allowed origin however it was sent, and local tools that send neither header.
  for (const h of [
    { origin: own },
    { origin: own, "sec-fetch-site": "same-origin" },
    { origin: "http://ui.example.test" },
    { origin: "http://ui.example.test", "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "none" },
    {},
  ])
    assert.equal(writeAllowed(at("POST", h), allowed), true, JSON.stringify(h));
  // Upgrades follow the same rule whatever their method.
  assert.equal(fromOwnPages(at("GET", { origin: "http://evil.example" })), false);
  assert.equal(fromOwnPages(at("GET", { origin: "null" })), false);
  assert.equal(fromOwnPages(at("GET", { origin: own })), true);
  assert.equal(fromOwnPages(at("GET", {})), true);
});

test("loopback admission: a change from another site gets 403 with a plain reason; the Host rule still holds", () => {
  const gate = loopbackAdmission({
    ports: () => [8890],
    allowedOrigins: new Set(["http://ui.example.test"]),
  });
  const answer = () => {
    const r = { status: null, body: "" };
    r.writeHead = (code) => (r.status = code);
    r.end = (b) => (r.body = String(b ?? ""));
    return r;
  };
  const run = (req) => {
    const res = answer();
    let admitted = null;
    gate.http(req, res, (p) => (admitted = p));
    return { res, admitted };
  };
  const evil = run(at("POST", { origin: "http://evil.example" }));
  assert.equal(evil.admitted, null);
  assert.equal(evil.res.status, 403);
  assert.match(evil.res.body, /takes changes only from its own pages/);
  assert.match(evil.res.body, /STUDIO_ALLOWED_ORIGINS/);
  assert.equal(run(at("POST", { origin: "http://127.0.0.1:8890" })).admitted.access, "owner");
  assert.equal(run(at("POST", { origin: "http://ui.example.test" })).admitted.access, "owner");
  assert.equal(run(at("POST", {})).admitted.access, "owner");
  // A foreign Host is refused first, with its own reason, even from the Studio's "own" Origin.
  const rebound = run({ method: "POST", headers: { host: "rebound.example:8890" } });
  assert.equal(rebound.res.status, 403);
  assert.match(rebound.res.body, /only on this computer/);

  const up = (headers) => {
    let admitted = null,
      ended = null;
    const socket = { end: (s) => (ended = s), destroy() {} };
    gate.upgrade(at("GET", headers), socket, Buffer.alloc(0), (p) => (admitted = p));
    return { admitted, ended };
  };
  assert.match(up({ origin: "http://evil.example" }).ended, /^HTTP\/1\.1 403/);
  assert.match(up({ origin: "null" }).ended, /^HTTP\/1\.1 403/);
  assert.equal(up({ origin: "http://127.0.0.1:8890" }).admitted.access, "owner");
  assert.equal(up({ origin: "http://ui.example.test" }).admitted.access, "owner");
  assert.equal(up({}).admitted.access, "owner");
  assert.match(gate.describe, /1 allowed origin/);
});

test("the health check is GET or HEAD on /healthz only", () => {
  const u = (p) => new URL(p, "http://x");
  assert.equal(isHealth({ method: "GET" }, u("/healthz")), true);
  assert.equal(isHealth({ method: "HEAD" }, u("/healthz")), true);
  assert.equal(isHealth({ method: "POST" }, u("/healthz")), false);
  assert.equal(isHealth({ method: "GET" }, u("/healthz/x")), false);
});

test("a hook module must provide both admission functions; optional seams must be functions", () => {
  const admission = { http() {}, upgrade() {} };
  assert.throws(() => checkHooks(null, "m"), /must return an object/);
  assert.throws(() => checkHooks({ admission: { http() {} } }, "m"), /admission/);
  assert.throws(() => checkHooks({ admission, place: "x" }, "m"), /place must be a function/);
  assert.throws(() => checkHooks({ admission, child: { env: 1 } }, "m"), /child.env/);
  const h = checkHooks({ admission, describe: "door" }, "m");
  assert.equal(h.describe, "door");
  assert.deepEqual(h.child.env(), {});
  assert.deepEqual(h.child.nodeArgs(), []);
  assert.deepEqual(h.child.headers(), {});
});

test("no hooks named: the loopback default; a named module that fails to load throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-load-"));
  try {
    const d = await loadServerHooks({ config: {}, env: {}, studioDir: dir, ports: () => [1] });
    assert.equal(d.local, true);
    await assert.rejects(
      loadServerHooks({ config: { serverHooks: "missing.mjs" }, env: {}, studioDir: dir }),
      /could not load/,
    );
    write(path.join(dir, "nodefault.mjs"), "export const x = 1;");
    await assert.rejects(
      loadServerHooks({ config: { serverHooks: "nodefault.mjs" }, env: {}, studioDir: dir }),
      /default export/,
    );
    write(
      path.join(dir, "env.mjs"),
      "export default () => ({ admission: { http() {}, upgrade() {} }, describe: 'from env' });",
    );
    const e = await loadServerHooks({
      config: {},
      env: { STUDIO_SERVER_HOOKS: "env.mjs" },
      studioDir: dir,
      ctx: {},
    });
    assert.equal(e.describe, "from env");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a real Studio -------------------------------------------------------
// One app whose provider echoes the headers it received, so a test can see what reached a child.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-hooks-"));
  const studio = path.join(root, "studio");
  const apps = path.join(root, "apps");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  write(path.join(studio, "surfaces.json"), { chatSeats: [] });
  write(path.join(apps, "apps/echo/app.json"), {
    id: "echo",
    name: "echo",
    surface: { path: "/surfaces/echo.html", entry: "index.html" },
    provider: { package: "@example/echo", required: true },
  });
  write(path.join(apps, "apps/echo/index.html"), "<h1>echo</h1>");
  write(path.join(apps, "providers/echo/provider.json"), {
    package: "@example/echo",
    run: { entry: "server.mjs", args: ["--port", "{{port}}"] },
    verbs: ["/api/echo"],
    serves: ["/echo-assets/"],
  });
  write(
    path.join(apps, "providers/echo/server.mjs"),
    "import http from'node:http';http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({headers:q.headers,argv:process.execArgv,env:process.env.HOOK_CHILD_ENV??null}))}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1')",
  );
  const children = [];
  t.after(async () => {
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
    await delay(40);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    studio,
    async start(extra = {}, env = {}) {
      write(path.join(studio, "studio.json"), {
        port: 0,
        appsRoot: apps,
        apps: ["echo"],
        ...extra,
      });
      const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
        env: { PATH: bin, OPENRIG_STUDIO_DIR: studio, ...env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(c);
      let log = "";
      let port = null;
      c.stdout.on("data", (b) => {
        log += b;
        port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
      });
      c.stderr.on("data", (b) => (log += b));
      const exited = new Promise((r) => c.once("exit", (code) => r(code)));
      return {
        exited,
        log: () => log,
        get port() {
          return port;
        },
        async ready() {
          for (let i = 0; i < 150; i++) {
            if (c.exitCode !== null) throw Error(log);
            if (port) {
              const r = await get(port, "/api/echo").catch(() => null);
              const c = await get(port, "/api/contract").catch(() => null);
              const h = await get(port, "/healthz").catch(() => null);
              if (r && r.status !== 502 && c && c.status === 200 && h && h.status === 200) return;
            }
            await delay(40);
          }
          throw Error(log);
        },
      };
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

function send(port, method, p, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

// Writes raw bytes to the Studio's port and resolves with whatever came back before it closed (or after a short wait).
function raw(port, bytes) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let got = "";
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(got);
    };
    const timer = setTimeout(done, 2000);
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (b) => {
      got += b;
      if (/\r\n\r\n/.test(got)) done();
    });
    socket.on("error", done);
    socket.on("close", done);
  });
}

// Resolves with the first status line of an upgrade attempt, or "closed".
function upgrade(port, p, host, extra = {}) {
  return new Promise((resolve) => {
    const r = http.request({
      host: "127.0.0.1",
      port,
      path: p,
      headers: {
        ...extra,
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    r.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    r.on("response", (res) => resolve(res.statusCode));
    r.on("error", () => resolve("closed"));
    r.end();
  });
}

test("default Studio: a foreign Host is refused for requests and upgrades; /healthz is never gated", async (t) => {
  const s = await fixture(t).start();
  await s.ready();
  const ok = await get(s.port, "/api/echo");
  assert.equal(ok.status, 200);
  const foreign = await get(s.port, "/api/echo", { host: "rebound.example:" + s.port });
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /only on this computer/);
  assert.equal(await upgrade(s.port, "/chat", "rebound.example:" + s.port), 403);
  // Any Host may ask how the box is; only this computer's own address reads which children it runs.
  const health = await get(s.port, "/healthz", { host: "rebound.example" });
  assert.equal(health.status, 200, health.body);
  assert.deepEqual(JSON.parse(health.body), { ok: true });
  const local = await get(s.port, "/healthz");
  const h = JSON.parse(local.body);
  assert.equal(h.ok, true);
  assert.deepEqual(h.children.map((c) => [c.kind, c.up, c.listening]).sort(), [
    ["provider", true, true],
    ["runtime", true, true],
  ]);
  assert.ok(
    h.children.every((c) => Number.isInteger(c.pid) && Number.isInteger(c.port)),
    local.body,
  );
  for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`])
    assert.ok(JSON.parse((await get(s.port, "/healthz", { host })).body).children, host);
  // A loopback name on another port is not this Studio's own address.
  assert.deepEqual(JSON.parse((await get(s.port, "/healthz", { host: "127.0.0.1:1" })).body), {
    ok: true,
  });
  // The shell may be framed only by this Studio's own pages.
  const shell = await get(s.port, "/");
  assert.equal(shell.status, 200);
  assert.equal(shell.headers["content-security-policy"], "frame-ancestors 'self'");
  assert.equal(shell.headers["x-frame-options"], "SAMEORIGIN");
  const place = JSON.parse((await get(s.port, "/api/studio/place")).body);
  assert.equal(place.profile, "local");
  assert.equal(place.access, "owner");
  assert.equal(place.workspace, "full");
  assert.match(s.log(), /door {4}: this computer only/);
});

test("/healthz detail: a STUDIO_ALLOWED_HOSTS value reads it like a loopback Host", async (t) => {
  const s = await fixture(t).start({}, { STUDIO_ALLOWED_HOSTS: "studio.example.net" });
  await s.ready();
  const allowed = JSON.parse((await get(s.port, "/healthz", { host: "studio.example.net" })).body);
  assert.equal(allowed.children.length, 2);
  const other = JSON.parse((await get(s.port, "/healthz", { host: "other.example.net" })).body);
  assert.deepEqual(other, { ok: true });
});

test("healthDetailAllowed: this computer on a loopback Studio; behind hooks, only when the box opts in", () => {
  const ports = () => [8890];
  const hooksBox = { local: false, admission: { http() {}, upgrade() {} } };
  const foreign = { headers: { host: "box.example" } };
  assert.equal(healthDetailAllowed(req("127.0.0.1:8890"), { hooks: null, ports }), true);
  assert.equal(healthDetailAllowed(foreign, { hooks: null, ports }), false);
  assert.equal(healthDetailAllowed(foreign, { hooks: { local: true }, ports }), false);
  // Behind hooks a loopback Host proves nothing (a tunnel can forward with one), and admission is never asked for a probe.
  assert.equal(
    healthDetailAllowed(req("127.0.0.1:8890"), { hooks: hooksBox, ports, env: {} }),
    false,
  );
  assert.equal(healthDetailAllowed(foreign, { hooks: hooksBox, ports, env: {} }), false);
  assert.equal(
    healthDetailAllowed(foreign, { hooks: hooksBox, ports, env: { STUDIO_HEALTH_DETAIL: "1" } }),
    true,
  );
  assert.equal(
    healthDetailAllowed(foreign, { hooks: hooksBox, ports, env: { STUDIO_HEALTH_DETAIL: "yes" } }),
    false,
  );
});

const HOOK = `
import fs from "node:fs";
import path from "node:path";
export default function install(ctx) {
  ctx.log("composed at install: " + ctx.surfaces().join(","));
  return {
    describe: "test door",
    admission: {
      http(req, res, next) {
        if (req.headers["x-test-person"] !== "ada") { res.writeHead(401); return res.end("sign in"); }
        // Admission may rewrite the request's headers; the Studio forwards them unchanged.
        req.headers["x-openrig-identity"] = "ada";
        next({ workspace: req.headers["x-test-files"] ? "files" : "full", access: "evaluator", email: "ada@example.test" });
      },
      upgrade(req, socket, head, next) {
        if (req.headers["x-test-person"] !== "ada") return socket.end("HTTP/1.1 401 Unauthorized\\r\\ncontent-length: 0\\r\\n\\r\\n");
        next({ workspace: "files", access: "evaluator" });
      },
    },
    transformShell: (html, { principal, surfaces, served }) => html.replace("<head>", '<head><meta name="test-door" content="' + principal.access + ' ' + surfaces.join(",") + ' ' + served.join(",") + '">'),
    // A files-only guest's box has no name to show here: null, never the Studio's own.
    place: (p) => ({ label: p.workspace === "files" ? null : "Test place", account: "https://account.example.test/" }),
    child: { env: () => ({ HOOK_CHILD_ENV: "set" }), headers: () => ({ "x-test-child": "k" }) },
    // Hears each health answer; its own failure must not reach the answer.
    onHealth(report) {
      fs.appendFileSync(path.join(ctx.studioDir, "health.log"), JSON.stringify({ ok: report.ok, method: report.method, kinds: report.children.map((c) => c.kind).sort() }) + "\\n");
      throw new Error("the hook's own failure");
    },
  };
}`;

test("hooks: admission decides, headers it writes reach providers, shell and place come from the hook", async (t) => {
  const f = fixture(t);
  write(path.join(f.studio, "door.mjs"), HOOK);
  const s = await f.start({ serverHooks: "door.mjs" });
  for (let i = 0; i < 150 && !s.port; i++) await delay(40);
  assert.ok(s.port, s.log());
  const ada = { "x-test-person": "ada" };
  // Ready once the provider answers and every child is up (the shell below comes from the runtime).
  for (let i = 0; i < 150; i++) {
    const r = await get(s.port, "/api/echo", ada).catch(() => null);
    const h = await get(s.port, "/healthz").catch(() => null);
    if (r && r.status === 200 && h && h.status === 200) break;
    await delay(40);
  }
  assert.match(s.log(), /door {4}: test door/);
  // A foreign Host is the hook's business now, not the loopback gate's.
  const refused = await get(s.port, "/api/echo", { host: "box.example.test" });
  assert.equal(refused.status, 401);
  const echo = JSON.parse(
    (await get(s.port, "/api/echo", { ...ada, host: "box.example.test" })).body,
  );
  assert.equal(echo.headers["x-openrig-identity"], "ada");
  assert.equal(echo.headers["x-test-child"], "k");
  assert.equal(echo.env, "set");
  const place = JSON.parse((await get(s.port, "/api/studio/place", ada)).body);
  assert.equal(place.profile, "hosted");
  assert.equal(place.access, "evaluator");
  assert.equal(place.label, "Test place");
  assert.equal(place.account, "https://account.example.test/");
  const files = JSON.parse(
    (await get(s.port, "/api/studio/place", { ...ada, "x-test-files": "1" })).body,
  );
  assert.equal(files.workspace, "files");
  assert.equal(files.terminal, null);
  assert.equal(files.label, null, "a hook's null label is answered as null");
  const shell = await get(s.port, "/", ada);
  assert.equal(shell.status, 200);
  assert.match(
    shell.body,
    /<meta name="test-door" content="evaluator floor,echo \/echo-assets\/">/,
  );
  assert.match(s.log(), /hooks {3}: composed at install: floor,echo/);
  assert.equal(shell.headers["cache-control"], "no-store");
  // A hook's transform keeps the shell's frame rule.
  assert.equal(shell.headers["content-security-policy"], "frame-ancestors 'self'");
  assert.equal(await upgrade(s.port, "/chat", "box.example.test"), 401);
  // Behind hooks, /healthz says how the box is and nothing more, to anyone (admitted or not, loopback Host or not), unless
  // the box opts in with STUDIO_HEALTH_DETAIL=1 (the next test).
  const health = await get(s.port, "/healthz", { host: "box.example.test" });
  assert.notEqual(health.status, 401);
  assert.deepEqual(Object.keys(JSON.parse(health.body)), ["ok"]);
  for (const h of [{ ...ada, host: "box.example.test" }, {}])
    assert.deepEqual(Object.keys(JSON.parse((await get(s.port, "/healthz", h)).body)), ["ok"]);
  // onHealth heard that answer (after it went out), and its throw changed nothing: the next answer is the same.
  const healthLog = path.join(f.studio, "health.log");
  // Read once a whole line is there: the file can exist a moment before its first line is written.
  const whole = () => fs.existsSync(healthLog) && fs.readFileSync(healthLog, "utf8").endsWith("\n");
  for (let i = 0; i < 100 && !whole(); i++) await delay(20);
  const heard = fs
    .readFileSync(healthLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(heard.at(-1), {
    ok: JSON.parse(health.body).ok,
    method: "GET",
    kinds: ["provider", "runtime"],
  });
  assert.equal((await get(s.port, "/healthz")).status, health.status);
});

test("behind hooks, STUDIO_HEALTH_DETAIL=1 lists the children to anyone (a box's own install check)", async (t) => {
  const f = fixture(t);
  write(path.join(f.studio, "door.mjs"), HOOK);
  const s = await f.start({ serverHooks: "door.mjs" }, { STUDIO_HEALTH_DETAIL: "1" });
  for (let i = 0; i < 150 && !s.port; i++) await delay(40);
  assert.ok(s.port, s.log());
  let h = null;
  for (let i = 0; i < 150; i++) {
    h = await get(s.port, "/healthz", { host: "box.example.test" }).catch(() => null);
    if (h && h.status === 200) break;
    await delay(40);
  }
  assert.deepEqual(
    JSON.parse(h.body)
      .children.map((c) => c.kind)
      .sort(),
    ["provider", "runtime"],
  );
});

test("onHealth is never awaited, and a throw or a rejection from it is swallowed", async () => {
  const seen = [];
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    let resolveSlow;
    const slow = new Promise((r) => (resolveSlow = r));
    notifyHealth({ onHealth: () => slow }, { ok: true, children: [] });
    notifyHealth({ onHealth: (r) => seen.push(r.ok) }, { ok: false, children: [] });
    notifyHealth(
      {
        onHealth: () => {
          throw new Error("sync");
        },
      },
      { ok: true, children: [] },
    );
    notifyHealth(
      {
        onHealth: async () => {
          throw new Error("async");
        },
      },
      { ok: true, children: [] },
    );
    notifyHealth({ onHealth: null }, { ok: true, children: [] });
    notifyHealth(null, { ok: true, children: [] });
    await delay(20);
    assert.deepEqual(seen, [false]);
    assert.deepEqual(unhandled, []);
    resolveSlow();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.throws(
    () => checkHooks({ admission: { http() {}, upgrade() {} }, onHealth: 1 }, "m"),
    /onHealth must be a function/,
  );
});

test("a named hook module that can't load stops the boot", async (t) => {
  const s = await fixture(t).start({ serverHooks: "nowhere.mjs" });
  assert.equal(await s.exited, 1);
  assert.match(s.log(), /server hooks .*nowhere\.mjs: could not load/);
  assert.match(s.log(), /Refusing to start/);
});

test("the runtime and providers answer only this Studio: a direct request to their port is refused", async (t) => {
  const s = await fixture(t).start();
  await s.ready();
  const providerPort = Number(s.log().match(/provider: @example\/echo on (\d+)/)?.[1]);
  assert.ok(providerPort, s.log());
  const direct = await get(providerPort, "/api/echo");
  assert.equal(direct.status, 403);
  assert.match(direct.body, /only answers the Studio itself/);
  const through = JSON.parse((await get(s.port, "/api/echo")).body);
  // The key is stripped before the provider's own code sees the request, and never in its environment.
  assert.equal(through.headers["x-openrig-studio-key"], undefined);
  assert.ok(through.argv.some((a) => a.endsWith("/tools/child-key.mjs")));
  assert.match(s.log(), /key {5}: the runtime and providers answer only this process/);
  assert.doesNotMatch(s.log(), /[0-9a-f]{64}/);
});

// ---- the Origin rule on a real Studio --------------------------------------
test("a real Studio: a cross-site change to a provider verb or the runtime is refused; its own pages, an allowed origin and local tools work", async (t) => {
  const s = await fixture(t).start({}, { STUDIO_ALLOWED_ORIGINS: "http://ui.example.test" });
  await s.ready();
  const own = `http://127.0.0.1:${s.port}`;
  const json = { "content-type": "application/json" };
  const textPlain = { "content-type": "text/plain" };
  // A form or a no-cors fetch from another site: text/plain, with the browser's Origin and Sec-Fetch-Site.
  for (const [p, headers] of [
    ["/api/echo", { ...textPlain, origin: "http://evil.example", "sec-fetch-site": "cross-site" }],
    ["/api/focus", { ...textPlain, origin: "http://evil.example", "sec-fetch-site": "cross-site" }],
    ["/api/echo", { ...textPlain, "sec-fetch-site": "cross-site" }],
    ["/api/focus", { ...json, origin: "null" }],
    [
      "/api/echo",
      { ...json, origin: "http://localhost:" + s.port, "sec-fetch-site": "cross-site" },
    ],
  ]) {
    const r = await send(s.port, "POST", p, headers, "{}");
    assert.equal(r.status, 403, `${p} ${JSON.stringify(headers)} ${r.body}`);
    assert.match(r.body, /takes changes only from its own pages/);
  }
  // The same POSTs from the Studio's own page, an allowed origin, and a local tool reach the provider and the runtime.
  for (const headers of [
    { ...json, origin: own, "sec-fetch-site": "same-origin" },
    { ...json, origin: "http://ui.example.test" },
    json,
  ]) {
    const echo = await send(s.port, "POST", "/api/echo", headers, "{}");
    assert.equal(echo.status, 200, echo.body);
    assert.ok(JSON.parse(echo.body).headers, "positive control: the provider answered");
    const focus = await send(s.port, "POST", "/api/focus", headers, "{}");
    assert.notEqual(focus.status, 403, focus.body);
    assert.match(focus.headers["content-type"] ?? "", /json/, "the runtime answered");
  }
  // Reads from anywhere still work (the Host rule decides them), and an upgrade from another site is refused.
  assert.equal((await get(s.port, "/api/echo", { origin: "http://evil.example" })).status, 200);
  const localHost = `127.0.0.1:${s.port}`;
  assert.equal(
    await upgrade(s.port, "/terminal/ws", localHost, { origin: "http://evil.example" }),
    403,
  );
  assert.equal(await upgrade(s.port, "/terminal/ws", localHost, { origin: "null" }), 403);
  assert.match(
    s.log(),
    /door {4}: this computer only \(loopback Host \+ 1 allowed origin\(s\); changes from its own pages\)/,
  );
});

// ---- one request never stops the Studio --------------------------------------
test("a malformed request URL gets 400 (or a closed socket) and the Studio keeps serving", async (t) => {
  const s = await fixture(t).start();
  await s.ready();
  const host = `127.0.0.1:${s.port}`;
  assert.match(
    await raw(s.port, `GET //x:99999/a HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
    /^HTTP\/1\.1 400/,
  );
  assert.match(
    await raw(
      s.port,
      `GET //x:99999/a HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    ),
    /^HTTP\/1\.1 400/,
  );
  assert.equal((await get(s.port, "/healthz")).status, 200);
  assert.equal((await get(s.port, "/api/echo")).status, 200);
});

const FAULTY_HOOK = `
export default function install() {
  return {
    describe: "faulty door",
    admission: {
      http(req, res, next) {
        const how = req.headers["x-test"];
        if (how === "throw") throw new Error("the hook broke");
        if (how === "reject") return Promise.reject(new Error("the hook broke later"));
        if (how === "none") return next();
        if (how === "null") return next(null);
        next({ workspace: "full", access: "owner" });
      },
      upgrade(req, socket, head, next) {
        const how = req.headers["x-test"];
        if (how === "throw") throw new Error("the hook broke");
        if (how === "reject") return Promise.reject(new Error("the hook broke later"));
        if (how === "none") return next();
        next({ workspace: "full", access: "owner" });
      },
    },
  };
}`;

test("a hook whose admission throws or rejects answers 503; one that admits no principal answers 403; the Studio keeps serving", async (t) => {
  const f = fixture(t);
  write(path.join(f.studio, "door.mjs"), FAULTY_HOOK);
  const s = await f.start({ serverHooks: "door.mjs" });
  await s.ready();
  for (const how of ["throw", "reject"]) {
    assert.equal((await get(s.port, "/api/echo", { "x-test": how })).status, 503, how);
    assert.equal(
      await upgrade(s.port, "/chat", `127.0.0.1:${s.port}`, { "x-test": how }),
      503,
      how,
    );
  }
  for (const how of ["none", "null"]) {
    assert.equal((await get(s.port, "/api/echo", { "x-test": how })).status, 403, how);
    assert.equal((await get(s.port, "/api/studio/place", { "x-test": how })).status, 403, how);
  }
  assert.equal(await upgrade(s.port, "/chat", `127.0.0.1:${s.port}`, { "x-test": "none" }), 403);
  // Positive control: the same hook admits a real principal, and the Studio is still up after all of the above.
  assert.equal((await get(s.port, "/api/echo")).status, 200);
  assert.equal((await get(s.port, "/healthz")).status, 200);
});
