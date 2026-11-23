// studio.json "rig": false: a box that never attaches a rig never runs the rig CLI at all.
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

// A stand-in rig CLI on PATH that writes down every call, so a test can see whether it was run.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-rig-"));
  const studio = path.join(root, "studio");
  const bin = path.join(root, "bin");
  const calls = path.join(root, "rig-calls.txt");
  fs.mkdirSync(studio);
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(path.join(bin, "rig"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`, {
    mode: 0o700,
  });
  const kids = [];
  t.after(async () => {
    for (const c of kids) {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {}
    }
    await delay(200);
    for (const c of kids) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    studio,
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : ""),
    async start(cfg = {}, seats) {
      if (seats) fs.writeFileSync(path.join(studio, "surfaces.json"), JSON.stringify(seats));
      fs.writeFileSync(path.join(studio, "studio.json"), JSON.stringify({ port: 0, ...cfg }));
      const c = spawn(process.execPath, [path.join(ROOT, "tools/studio.mjs")], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, OPENRIG_STUDIO_DIR: studio },
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
        if (port && (await status(port, "/api/contract")) === 200) break;
        await delay(50);
      }
      return { port, log: () => log };
    },
  };
}

const status = (port, p) =>
  new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", () => resolve(0));
  });

test('"rig": false: the rig CLI is never run, and the boot log says why there is no rig', async (t) => {
  const f = fixture(t);
  const s = await f.start({ rig: false });
  assert.ok(s.port, s.log());
  assert.equal(f.calls(), "", "no whoami, no rig list, no roster read");
  assert.match(s.log(), /rig {5}: never attached here \(studio\.json "rig": false\)/);
  assert.match(s.log(), /seats {3}: a rig is never attached here/);
});

test('"rig": false still honours a roster the studio declares itself', async (t) => {
  const f = fixture(t);
  const s = await f.start({ rig: false }, { chatSeats: [{ seat: "one@declared", name: "one" }] });
  assert.equal(f.calls(), "");
  assert.match(s.log(), /seats {3}: 1 seat\(s\) declared by this studio \[declared\]/);
});

test("without the switch the same box does ask the rig CLI (so the stand-in would have seen a call)", async (t) => {
  const f = fixture(t);
  const s = await f.start();
  assert.ok(s.port, s.log());
  assert.match(f.calls(), /whoami --json/);
  assert.match(f.calls(), /ps --nodes -A --json/);
});

const getJson = (port, p) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(JSON.parse(b)));
      })
      .on("error", reject);
  });

test("a roster read from the rig, with no ttyd: no 'declared' warning, and the shell is told it came from the rig", async (t) => {
  const f = fixture(t);
  const nodes = JSON.stringify([
    {
      rigName: "my-rig",
      logicalId: "build.one",
      canonicalSessionName: "build-one@my-rig",
      sessionStatus: "running",
    },
    {
      rigName: "my-rig",
      logicalId: "build.two",
      canonicalSessionName: "build-two@my-rig",
      sessionStatus: "exited",
    },
  ]);
  fs.writeFileSync(
    path.join(path.dirname(f.studio), "bin", "rig"),
    `#!/bin/sh\n[ "$1" = ps ] && { echo '${nodes}'; exit 0; }\nexit 1\n`,
    { mode: 0o700 },
  );
  const s = await f.start({ rig: "my-rig" });
  assert.ok(s.port, s.log());
  // ttyd isn't on this PATH, so the launcher's own line says why the seats aren't attachable.
  assert.match(s.log(), /seats {3}: 2 seat\(s\) from rig my-rig \(1 running\) \[rig\] · NO ttyd/);
  assert.doesNotMatch(s.log(), /chatSeats declared without chatLocalPort/);
  const m = await getJson(s.port, "/surfaces.json");
  assert.equal(m.chatSeatsFrom, "rig");
  assert.equal(m.chatSeats.length, 2);
  assert.equal(m.chatLocalPort, undefined);
  const c = await getJson(s.port, "/api/contract");
  assert.doesNotMatch((c.manifest.warnings || []).join("\n"), /chatLocalPort/);
});
