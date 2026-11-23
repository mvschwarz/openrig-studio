// A generated app's own listener (tools/project-app-server.mjs): off without admission, and behind it only the
// app's files. The test hook admits a request that carries x-test-person, as a principal built from test headers,
// and refuses everything else with its own answer, so a test can tell the hook's refusal from the listener's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkProjectAppHooks,
  createProjectAppServer,
  loadProjectAppHooks,
} from "../tools/project-app-server.mjs";
import { loopbackAdmission } from "../tools/server-hooks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = "https://app.example.invalid";
const STUDIO = "https://studio.example.invalid";

// The test admission, counting what it was asked.
function testHooks() {
  const seen = { http: 0, upgrade: 0, closed: false };
  const principal = (req) =>
    req.headers["x-test-person"]
      ? {
          email: req.headers["x-test-person"],
          access: req.headers["x-test-access"] ?? "evaluator",
          workspace: req.headers["x-test-workspace"] ?? "full",
        }
      : null;
  const hooks = checkProjectAppHooks(
    {
      describe: "test door",
      admission: {
        async http(req, res, next) {
          seen.http++;
          const p = principal(req);
          if (p) return next(p);
          res.writeHead(403, { "x-test-refused": "1" });
          res.end();
        },
        upgrade(req, socket, head, next) {
          seen.upgrade++;
          const p = principal(req);
          if (p) return next(p);
          socket.end("HTTP/1.1 401 Unauthorized\r\nx-test-refused: 1\r\ncontent-length: 0\r\n\r\n");
        },
      },
      close() {
        seen.closed = true;
      },
    },
    "test",
  );
  return { hooks, seen };
}

function appFolder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-app-server-"));
  fs.writeFileSync(path.join(root, "index.html"), "original assets");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function listen(t, server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return server.address().port;
}

const PERSON = { "x-test-person": "ada@example.invalid" };

function get(port, p, init = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: init.method || "GET",
        headers: { host: "app.example.invalid", ...init.headers },
      },
      (r) => {
        const parts = [];
        r.on("data", (b) => parts.push(b));
        r.on("end", () =>
          resolve({
            status: r.statusCode,
            headers: r.headers,
            body: Buffer.concat(parts).toString(),
          }),
        );
      },
    );
    q.on("error", reject);
    q.end(init.body);
  });
}

// A raw WebSocket handshake; resolves with the status line and the head.
function upgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const all = {
        host: "app.example.invalid",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      };
      s.write(
        `GET /project-apps/checklist/ws HTTP/1.1\r\n${Object.entries(all)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
    });
    let buf = "";
    s.on("data", (b) => (buf += b));
    s.on("close", () => resolve({ status: buf.split("\r\n")[0], head: buf }));
    s.on("error", reject);
  });
}

test("off without admission: no hooks, an empty one, or the loopback default never makes a listener", (t) => {
  const root = appFolder(t);
  const base = { root, app: "checklist", origin: APP };
  for (const hooks of [undefined, null, {}, { admission: { http() {} } }])
    assert.throws(() => createProjectAppServer({ ...base, hooks }), /off without an admission/);
  const local = { admission: loopbackAdmission({ ports: () => [1] }) };
  assert.throws(() => createProjectAppServer({ ...base, hooks: local }), /loopback/);
  assert.throws(() => checkProjectAppHooks(local, "m"), /loopback/);
  assert.throws(() => checkProjectAppHooks(null, "m"), /must return an object/);
  assert.throws(() => checkProjectAppHooks({ admission: { http() {} } }, "m"), /admission/);
  const admission = { http() {}, upgrade() {} };
  assert.throws(() => checkProjectAppHooks({ admission, close: 1 }, "m"), /close/);
  const { hooks } = testHooks();
  for (const origin of [
    "http://app.example.invalid",
    "https://app.example.invalid/",
    "https://u:p@app.example.invalid",
  ])
    assert.throws(() => createProjectAppServer({ ...base, origin, hooks }), /app origin/);
  assert.throws(() => createProjectAppServer({ ...base, app: "Bad/id", hooks }), /app id/);
  assert.throws(() => createProjectAppServer({ ...base, root: "relative", hooks }), /app id/);
  assert.throws(
    () =>
      createProjectAppServer({ ...base, studioOrigin: "https://studio.example.invalid/x", hooks }),
    /Studio return origin/,
  );
  assert.ok(createProjectAppServer({ ...base, origin: "http://127.0.0.1:9", hooks }));
});

test("the loader: a module that can't load, or offers no projectApp, keeps project apps off; ctx carries no environment", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-app-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(loadProjectAppHooks(path.join(dir, "missing.mjs"), {}), /could not load/);
  fs.writeFileSync(path.join(dir, "studio-only.mjs"), "export default () => ({});");
  await assert.rejects(
    loadProjectAppHooks(path.join(dir, "studio-only.mjs"), {}),
    /no projectApp\(ctx\) export, so project apps are off/,
  );
  fs.writeFileSync(
    path.join(dir, "bad.mjs"),
    "export const projectApp = () => ({ admission: {} });",
  );
  await assert.rejects(loadProjectAppHooks(path.join(dir, "bad.mjs"), {}), /admission/);
  fs.writeFileSync(
    path.join(dir, "good.mjs"),
    [
      "export let lastCtx = null;",
      "export async function projectApp(ctx) {",
      "  lastCtx = ctx;",
      "  return { describe: 'test door for ' + ctx.origin, admission: { http() {}, upgrade() {} } };",
      "}",
    ].join("\n"),
  );
  const ctx = { app: "checklist", origin: APP, studioOrigin: null, binding: { k: "v" }, log() {} };
  const h = await loadProjectAppHooks(path.join(dir, "good.mjs"), ctx);
  assert.equal(h.describe, `test door for ${APP}`);
  const mod = await import(pathToFileURL(path.join(dir, "good.mjs")).href);
  assert.equal(mod.lastCtx, ctx);
});

test("admission decides: admitted gets the files, refused gets the hook's own answer; a foreign Host is 421 first", async (t) => {
  const root = appFolder(t);
  const { hooks, seen } = testHooks();
  const port = await listen(
    t,
    createProjectAppServer({ root, app: "checklist", origin: APP, hooks }),
  );
  const ok = await get(port, "/project-apps/checklist/", { headers: PERSON });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "original assets");
  assert.equal(ok.headers["cache-control"], "no-store");
  const refused = await get(port, "/project-apps/checklist/");
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["x-test-refused"], "1", "the hook's refusal, not the listener's");
  assert.equal(refused.body, "");
  // The SDK doesn't narrow project apps by role or workspace: admission decides who is admitted.
  for (const extra of [{ "x-test-access": "owner" }, { "x-test-workspace": "files" }])
    assert.equal(
      (await get(port, "/project-apps/checklist/", { headers: { ...PERSON, ...extra } })).status,
      200,
    );
  const before = seen.http;
  const foreign = await get(port, "/project-apps/checklist/", {
    headers: { ...PERSON, host: "studio.example.invalid" },
  });
  assert.equal(foreign.status, 421);
  assert.equal(seen.http, before, "a foreign Host never reaches admission");
  assert.equal(seen.http, 4);
});

test("an admission that throws or rejects, or admits with no principal, is a refusal", async (t) => {
  const root = appFolder(t);
  let mode = "throw";
  const hooks = checkProjectAppHooks(
    {
      admission: {
        http(req, res, next) {
          if (mode === "throw") throw new Error("door broke");
          if (mode === "reject") return Promise.reject(new Error("door broke"));
          return next();
        },
        upgrade(req, socket) {
          throw new Error("door broke " + socket.remoteAddress);
        },
      },
    },
    "m",
  );
  const port = await listen(
    t,
    createProjectAppServer({ root, app: "checklist", origin: APP, hooks }),
  );
  assert.equal((await get(port, "/project-apps/checklist/")).status, 503);
  mode = "reject";
  assert.equal((await get(port, "/project-apps/checklist/")).status, 503);
  mode = "no principal";
  assert.equal((await get(port, "/project-apps/checklist/")).status, 403);
  assert.match((await upgrade(port, PERSON)).status, /^HTTP\/1\.1 503 /);
});

test("isolation: no Studio route, no write, no WebSocket; admission is still asked about every upgrade", async (t) => {
  const root = appFolder(t);
  const { hooks, seen } = testHooks();
  const port = await listen(
    t,
    createProjectAppServer({ root, app: "checklist", origin: APP, hooks }),
  );
  for (const p of [
    "/api/files/write",
    "/api/collab/act",
    "/api/studio/place",
    "/api/capture-target",
    "/api/agents/terminals",
    "/healthz",
    "/chat/",
    "/terminal/",
    "/team/",
    "/agents/type/",
    "/desktop/ws",
    "/surfaces/home.html",
    "/_openrig/auth-return?studio=https%3A%2F%2Fstudio.example.invalid%2F%3Fs%3Dchecklist",
  ])
    assert.equal((await get(port, p, { headers: PERSON })).status, 404, p);
  const post = await get(port, "/project-apps/checklist/", {
    method: "POST",
    headers: PERSON,
    body: "not written",
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal(fs.readFileSync(path.join(root, "index.html"), "utf8"), "original assets");

  const refused = await upgrade(port);
  assert.match(refused.status, /^HTTP\/1\.1 401 /, "the hook's own refusal");
  assert.match(refused.head, /x-test-refused: 1/);
  const admitted = await upgrade(port, PERSON);
  assert.match(admitted.status, /^HTTP\/1\.1 404 /, "admitted, but there is no WebSocket here");
  assert.equal(seen.upgrade, 2);
  const foreign = await upgrade(port, { ...PERSON, host: "studio.example.invalid" });
  assert.match(foreign.status, /^HTTP\/1\.1 421 /);
  assert.equal(seen.upgrade, 2, "a foreign Host never reaches admission");
});

test("the way back to the Studio: bound to its origin's root and this app, behind admission", async (t) => {
  const root = appFolder(t);
  const { hooks, seen } = testHooks();
  const port = await listen(
    t,
    createProjectAppServer({ root, app: "checklist", origin: APP, studioOrigin: STUDIO, hooks }),
  );
  const back = (target, init = {}) =>
    get(port, "/_openrig/auth-return?studio=" + encodeURIComponent(target), {
      headers: PERSON,
      ...init,
    });
  const target = `${STUDIO}/?s=checklist&h=%23open%3Dfile#retained`;
  const good = await back(target);
  assert.equal(good.status, 303);
  assert.equal(good.headers.location, target);
  assert.equal(good.headers["cache-control"], "no-store");
  assert.equal(good.headers["referrer-policy"], "no-referrer");
  for (const bad of [
    "https://other.example.invalid/?s=checklist",
    `${STUDIO}/?s=other`,
    `${STUDIO}/elsewhere?s=checklist`,
    `https://u:p@studio.example.invalid/?s=checklist`,
    "not a url",
  ])
    assert.equal((await back(bad)).status, 400, bad);
  assert.equal(
    (
      await get(port, `/_openrig/auth-return?studio=${encodeURIComponent(target)}&next=x`, {
        headers: PERSON,
      })
    ).status,
    400,
  );
  assert.equal((await back(target, { method: "POST", headers: PERSON })).status, 405);
  const refused = await back(target, { headers: {} });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.location, undefined);
  assert.equal(seen.http, 9);
});

test("closing the listener closes the hooks", async (t) => {
  const root = appFolder(t);
  const { hooks, seen } = testHooks();
  const s = createProjectAppServer({ root, app: "checklist", origin: APP, hooks });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  await new Promise((r) => s.close(r));
  assert.equal(seen.closed, true);
});

// ---- the command line, as a real process ----

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Runs the command line until it prints its boot line, or exits.
function run(t, args, env = {}, script = path.join(ROOT, "tools/project-app-server.mjs")) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  return new Promise((resolve) => {
    const done = (code) => resolve({ child, code, out: () => out });
    child.on("exit", (code) => done(code));
    child.stdout.on("data", () => {
      if (/door {4}: /.test(out)) done(null);
    });
  });
}

const HOOK = `
export function projectApp(ctx) {
  ctx.log("ctx keys " + Object.keys(ctx).sort().join(","));
  const allow = ctx.binding?.allow;
  const admit = (req) => req.headers["x-test-person"] === allow;
  return {
    describe: "test door, " + ctx.app + " at " + ctx.origin,
    admission: {
      http(req, res, next) { if (admit(req)) return next({ workspace: "full", access: "evaluator" }); res.writeHead(403); res.end(); },
      upgrade(req, socket, head, next) { if (admit(req)) return next({}); socket.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); },
    },
  };
}
`;

test("the command line: off without --hooks (the environment is never read); on with a hook and its binding", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-app-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "index.html"), "cli app");
  fs.writeFileSync(path.join(dir, "door.mjs"), HOOK);
  fs.writeFileSync(path.join(dir, "studio-only.mjs"), "export default () => ({});");
  fs.writeFileSync(
    path.join(dir, "binding.json"),
    JSON.stringify({ allow: "ada@example.invalid" }),
  );
  const port = await freePort();
  const base = ["--app", "checklist", "--root", app, "--origin", APP, "--port", String(port)];

  const off = await run(t, base, { STUDIO_SERVER_HOOKS: path.join(dir, "door.mjs") });
  assert.equal(off.code, 1);
  assert.match(off.out(), /off without an admission hook/);
  const studioOnly = await run(t, [...base, "--hooks", path.join(dir, "studio-only.mjs")]);
  assert.equal(studioOnly.code, 1);
  assert.match(studioOnly.out(), /no projectApp\(ctx\) export/);
  const relative = await run(t, [...base, "--hooks", "door.mjs"]);
  assert.equal(relative.code, 1);
  assert.match(relative.out(), /--hooks must be an absolute path/);

  const on = await run(t, [
    ...base,
    "--hooks",
    path.join(dir, "door.mjs"),
    "--auth-binding",
    path.join(dir, "binding.json"),
  ]);
  assert.equal(on.code, null, on.out());
  assert.match(on.out(), /ctx keys app,binding,log,origin,studioOrigin/);
  assert.match(
    on.out(),
    new RegExp(`project app: ${APP}/project-apps/checklist/ on 127\\.0\\.0\\.1:${port}`),
  );
  assert.match(on.out(), /door {4}: test door, checklist at https:\/\/app\.example\.invalid/);
  const ok = await get(port, "/project-apps/checklist/", { headers: PERSON });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "cli app");
  assert.equal((await get(port, "/project-apps/checklist/")).status, 403);
  assert.equal(
    (await get(port, "/project-apps/checklist/", { headers: { "x-test-person": "eve@x.invalid" } }))
      .status,
    403,
    "only whom the binding names",
  );
  const exited = new Promise((r) => on.child.on("exit", (code) => r(code)));
  on.child.kill("SIGTERM");
  assert.equal(await exited, 0);
});

test("the command line runs when it is invoked through a symlinked path", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-app-link-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "index.html"), "linked app");
  fs.writeFileSync(path.join(dir, "door.mjs"), HOOK);
  fs.writeFileSync(
    path.join(dir, "binding.json"),
    JSON.stringify({ allow: "ada@example.invalid" }),
  );
  // The tools folder reached through a link, as a package laid out through links (or a temp folder behind one) is.
  fs.symlinkSync(path.join(ROOT, "tools"), path.join(dir, "tools"));
  const linked = path.join(dir, "tools", "project-app-server.mjs");
  assert.notEqual(fs.realpathSync(linked), linked);
  const port = await freePort();
  const args = ["--app", "checklist", "--root", app, "--origin", APP, "--port", String(port)];
  const on = await run(
    t,
    [
      ...args,
      "--hooks",
      path.join(dir, "door.mjs"),
      "--auth-binding",
      path.join(dir, "binding.json"),
    ],
    {},
    linked,
  );
  assert.equal(on.code, null, on.out());
  assert.match(on.out(), /project app: .* on 127\.0\.0\.1:/);
  const ok = await get(port, "/project-apps/checklist/", { headers: PERSON });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "linked app");
  // And the same check still refuses without a hook, through the link.
  const off = await run(t, args, {}, linked);
  assert.equal(off.code, 1);
  assert.match(off.out(), /off without an admission hook/);
  const exited = new Promise((r) => on.child.on("exit", (code) => r(code)));
  on.child.kill("SIGTERM");
  assert.equal(await exited, 0);
});

// ---- the shell: a surface on another origin can't drive it ----

const shell = () => fs.readFileSync(path.join(ROOT, "app/shell.html"), "utf8");

test("the shell ignores messages from another origin; its own surfaces still work", async () => {
  const source = shell();
  const start = source.indexOf('  addEventListener("message", (e) => {');
  const end = source.indexOf("\n  });\n", start) + "\n  });\n".length;
  assert.ok(start > 0 && end > start);
  let handler,
    fetches = 0,
    opened = 0,
    headers = 0,
    activated = 0,
    markup = 0;
  const child = { postMessage() {} };
  const frame = { contentWindow: child, src: APP + "/project-apps/checklist/" };
  const context = {
    location: { origin: STUDIO, href: STUDIO + "/" },
    addEventListener: (_, fn) => (handler = fn),
    frames: new Map([["project", frame]]),
    activeId: "project",
    byId: (id) => (id === "files" ? { id } : null),
    activate: () => activated++,
    openAgents: () => opened++,
    setMarkup: () => markup++,
    refreshListeners: [],
    surfaceListeners: [],
    declaredTargets: new Map(),
    declaredContexts: new Map(),
    declaredHeaders: new Map(),
    renderAppHeader: () => headers++,
    fetch: async () => {
      fetches++;
      return Response.json({ ok: true, target: {} });
    },
    console,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const messages = [
    { t: "capture-target", root: "files", path: "controlled" },
    { t: "header", title: "changed" },
    { t: "open-agent", seat: "fixture" },
    { t: "open-surface", id: "files" },
    { t: "open-markup", on: true },
  ];
  for (const origin of [APP, "null"])
    for (const data of messages) handler({ origin, source: child, data });
  assert.deepEqual([fetches, opened, headers, activated, markup], [0, 0, 0, 0, 0]);
  for (const data of messages) handler({ origin: STUDIO, source: child, data });
  assert.deepEqual([fetches, opened, headers, activated, markup], [1, 1, 1, 1, 1]);
});

test("the shell sends no control messages to a surface on another origin", () => {
  const source = shell();
  const start = source.indexOf("  const tellSurface = (msg) => {");
  const end = source.indexOf("  // ONE PATH", start);
  assert.ok(start > 0 && end > start);
  let sent = 0,
    target = null;
  const frame = {
    src: APP + "/project-apps/checklist/",
    contentWindow: {
      postMessage: (_, o) => {
        sent++;
        target = o;
      },
    },
  };
  const context = {
    URL,
    location: { origin: STUDIO, href: STUDIO + "/" },
    frames: new Map([["project", frame]]),
    activeId: "project",
  };
  vm.runInNewContext(source.slice(start, end) + ";this.tell = tellSurface", context);
  context.tell({ t: "markup", on: true });
  assert.equal(sent, 0);
  frame.src = STUDIO + "/surfaces/home.html";
  context.tell({ t: "markup", on: true });
  assert.equal(sent, 1);
  assert.equal(target, STUDIO);
});
