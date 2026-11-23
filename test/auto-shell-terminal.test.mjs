// A fresh local Studio starts its owner's shell terminal itself when ttyd is installed and no socket is configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const delay = (n) => new Promise((r) => setTimeout(r, n));

// A stand-in ttyd: answers --version, and otherwise serves "inert" on the Unix socket given with -i (bound beside the path
// and renamed into place already 0660, as the real one leaves it).
const FAKE_TTYD = `#!${process.execPath}
import fs from "node:fs"; import http from "node:http";
const a = process.argv.slice(2);
if (a.includes("--version")) { console.log("ttyd 1.7.7"); process.exit(0); }
const p = a[a.indexOf("-i") + 1];
const s = http.createServer((q, r) => r.end("inert"));
s.listen(p + ".bind", () => { fs.chmodSync(p + ".bind", 0o660); fs.renameSync(p + ".bind", p); });
process.on("SIGTERM", () => s.close(() => process.exit(0)));
`;

function fixture(t, { ttyd = true } = {}) {
  // A short root keeps the auto socket path under the Unix limit.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ast-"));
  const studio = path.join(root, "s");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(studio);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  if (ttyd) fs.writeFileSync(path.join(bin, "ttyd"), FAKE_TTYD, { mode: 0o700 });
  fs.writeFileSync(path.join(studio, "surfaces.json"), JSON.stringify({ chatSeats: [] }));
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
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    studio,
    async start(extraEnv = {}, cfg = {}) {
      fs.writeFileSync(path.join(studio, "studio.json"), JSON.stringify({ port: 0, ...cfg }));
      const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, OPENRIG_STUDIO_DIR: studio, ...extraEnv },
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
      for (let i = 0; i < 200; i++) {
        if (c.exitCode !== null) throw Error(log);
        if (port) {
          const r = await get(port, "/api/contract").catch(() => null);
          if (r?.status === 200) break;
        }
        await delay(50);
      }
      return { port, log: () => log };
    },
  };
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

const place = async (port) => JSON.parse((await get(port, "/api/studio/place")).body);
async function placeTerminal(port) {
  for (let i = 0; i < 100; i++) {
    const p = await place(port);
    if (p.terminal) return p;
    await delay(50);
  }
  return place(port);
}

test("ttyd installed and no socket configured: the Studio starts the shell and serves /terminal/", async (t) => {
  const f = fixture(t);
  const s = await f.start();
  const p = await placeTerminal(s.port);
  assert.equal(p.terminal, "/terminal/", s.log());
  const page = await get(s.port, "/terminal/");
  assert.equal(page.body.includes("inert"), true, page.body);
  assert.match(s.log(), /terminal: the shell at \/terminal\/ \(started by this Studio; ttyd\)/);
  const sock = path.join(f.studio, ".runtime", "terminal", "shell.sock");
  assert.equal(fs.existsSync(sock), true);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  const h = JSON.parse((await get(s.port, "/healthz")).body);
  assert.ok(
    h.children.some((c) => c.kind === "terminal" && c.up),
    JSON.stringify(h),
  );
});

test("a socket left behind by a crash doesn't block the next boot", async (t) => {
  const f = fixture(t);
  const dir = path.join(f.studio, ".runtime", "terminal");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "shell.sock"), "stale");
  const s = await f.start();
  assert.equal((await placeTerminal(s.port)).terminal, "/terminal/", s.log());
});

test("a configured STUDIO_TERMINAL_SOCKET wins: the Studio starts nothing of its own", async (t) => {
  const f = fixture(t);
  const s = await f.start({ STUDIO_TERMINAL_SOCKET: path.join(f.root, "mine.sock") });
  assert.doesNotMatch(s.log(), /started by this Studio/);
  assert.equal(fs.existsSync(path.join(f.studio, ".runtime", "terminal")), false);
  assert.equal((await place(s.port)).terminal, null);
});

test("no ttyd: no shell, and place says so", async (t) => {
  const f = fixture(t, { ttyd: false });
  const s = await f.start();
  assert.doesNotMatch(s.log(), /started by this Studio/);
  const p = await place(s.port);
  assert.equal(p.terminal, null);
});

test("behind server hooks the Studio never starts its own shell", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.studio, "door.mjs"),
    "export default () => ({ admission: { http(q, s, next) { next({ workspace: 'full', access: 'owner' }); }, upgrade(q, so, h, next) { next({ workspace: 'full', access: 'owner' }); } } });",
  );
  const s = await f.start({}, { serverHooks: "door.mjs" });
  assert.doesNotMatch(s.log(), /started by this Studio/);
  assert.equal(fs.existsSync(path.join(f.studio, ".runtime", "terminal")), false);
});
