// A Studio with a server hook installed is served to other people, so it never guesses its rig: started from a managed
// session on a rig, it attaches that rig's seats only when studio.json names it. The loopback default still infers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_RIG = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "whoami") console.log(JSON.stringify({ identity: { rigName: "launch-rig", sessionName: "lead@launch-rig" } }));
else if (a[0] === "ps") console.log(JSON.stringify([{ rigName: "launch-rig", logicalId: "pod.lead", canonicalSessionName: "lead@launch-rig", sessionStatus: "running" }]));
else console.log("[]");
`;
const HOOK = `export default function install() {
  return { describe: "test door", admission: { http(req, res) { res.writeHead(401); res.end(); }, upgrade(req, socket) { socket.end("HTTP/1.1 401 Unauthorized\\\\r\\\\ncontent-length: 0\\\\r\\\\n\\\\r\\\\n"); } } };
}`;

async function boot(t, cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rig-published-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const studio = path.join(root, "studio"),
    bin = path.join(root, "bin");
  fs.mkdirSync(studio);
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "rig"), FAKE_RIG, { mode: 0o700 });
  fs.writeFileSync(path.join(studio, "door.mjs"), HOOK);
  fs.writeFileSync(path.join(studio, "studio.json"), JSON.stringify({ port: 0, ...cfg }));
  const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, OPENRIG_STUDIO_DIR: studio },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
  });
  let log = "";
  c.stdout.on("data", (b) => (log += b));
  c.stderr.on("data", (b) => (log += b));
  for (let i = 0; i < 150 && !/seats\s*:/.test(log) && c.exitCode === null; i++)
    await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  return log;
}

test("with a server hook and no declared rig, the Studio attaches no rig and says to choose one", async (t) => {
  const log = await boot(t, { serverHooks: "door.mjs" });
  assert.match(log, /seats\s*:/, log);
  assert.doesNotMatch(log, /seat\(s\) from rig launch-rig/, log);
  assert.match(log, /choose a rig in studio\.json .*started from launch-rig/, log);
});

test("with a server hook and a declared rig, that rig's seats are listed", async (t) => {
  const log = await boot(t, { serverHooks: "door.mjs", rig: "launch-rig" });
  assert.match(log, /seat\(s\) from rig launch-rig/, log);
});

test("the loopback default (no hook) still infers the rig it was started from", async (t) => {
  const log = await boot(t, {});
  assert.match(log, /seat\(s\) from rig launch-rig/, log);
});
