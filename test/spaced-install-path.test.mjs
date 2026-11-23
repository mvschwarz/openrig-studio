// An SDK installed under a path with a space must boot. A folder's path built from new URL(import.meta.url).pathname keeps the
// space encoded (%20), so the runtime, the seat script and the clipboard shim were named at paths that don't exist. Here the
// SDK, copied under "with space", boots and its runtime answers /api/contract; and no file in tools/ builds a path that way.
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
const status = (port, p) =>
  new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", () => resolve(0));
  });

test("an SDK under a path with a space boots, and its runtime answers /api/contract", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spaced-")));
  const sdk = path.join(root, "with space", "sdk");
  for (const e of fs.readdirSync(ROOT))
    if (!["node_modules", ".git"].includes(e))
      fs.cpSync(path.join(ROOT, e), path.join(sdk, e), { recursive: true });
  const studio = path.join(root, "studio");
  fs.mkdirSync(studio);
  fs.writeFileSync(
    path.join(studio, "studio.json"),
    JSON.stringify({ port: 0, rig: false, apps: [] }),
  );
  const c = spawn(process.execPath, [path.join(sdk, "tools", "studio.mjs")], {
    env: { PATH: "/usr/bin:/bin", HOME: root, OPENRIG_STUDIO_DIR: studio },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {}
    await delay(200);
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  let log = "";
  let port = null;
  c.stdout.on("data", (b) => {
    log += b;
    port ??= Number(log.match(/studio: http:\/\/127\.0\.0\.1:(\d+)\//)?.[1]) || null;
  });
  c.stderr.on("data", (b) => (log += b));
  let code = 0;
  for (let i = 0; i < 200 && code !== 200 && c.exitCode === null; i++) {
    if (port) code = await status(port, "/api/contract");
    if (code !== 200) await delay(50);
  }
  assert.equal(code, 200, `the runtime answers (exited ${c.exitCode}); log:\n${log.slice(-600)}`);
  assert.doesNotMatch(log, /%20/, "no path in the boot log carries an encoded space");
});

test("no file in tools/ builds a path from a URL's pathname (it keeps %20)", () => {
  const hits = fs
    .readdirSync(path.join(ROOT, "tools"))
    .filter((f) => /\.m?js$/.test(f))
    .filter((f) =>
      /new URL\([^)]*import\.meta\.url\)\.pathname/.test(
        fs.readFileSync(path.join(ROOT, "tools", f), "utf8"),
      ),
    );
  assert.deepEqual(hits, []);
});
