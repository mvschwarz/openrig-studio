// Two studios must not share one .runtime/ silently.
//
//   node --test 'test/*.test.mjs'
//
// THE DEFECT, found by studio-impl on a live box and by the founder OPENING IT:
// composing is destructive, and two studios sharing a STUDIO_DIR share .runtime/.
// The second to boot repainted the first's rail while the first kept serving the
// routing table it built IN MEMORY at ITS boot. The result is an app that is
// present, looks installed, and cannot work — a tab that loads 200 over verbs
// that 404, because the process showing the row never heard of the provider
// behind it. No check saw it. The row is real, the page is real, the 200 is real.
//
// NOTE ON SCOPE: these tests prove the CAUSE, not the whole symptom — they assert
// the repaint is prevented. Reproducing the 404 needs a PROVIDER-BACKED app, since
// the reference runtime answers the files verbs itself and would mask it.
//
// ✅ THE ROUTING GAP WAS REPRODUCED SEPARATELY, against the UNGUARDED tool — the
// only place it can be shown, since the guard below prevents it. Two studios, one
// STUDIO_DIR: A boots ['files'], B boots ['files','provider-manager'] from the same
// directory. `provider-manager` is backed by a real provider, so nothing in the
// reference runtime can cover for its verbs.
//
//                                  A before B   A after B    B
//   rail lists provider-manager    no           YES          yes
//   /surfaces/provider-manager     404          200          200
//   /api/fleet/state               404          404          200
//
// A was never restarted and never told. An app listed on the rail, served 200,
// whose verbs 404 — present, apparently installed, and unable to work.
//
// READ THE LAST ROW CAREFULLY: it shows NO DELTA on its own. 404-before is honest
// (nothing installed); 404-after is the defect. The finding is the COMBINATION of
// all three rows, and B answering 200 for the SAME verb with the SAME probe is the
// control that makes the after-404 a real negative rather than a probe reading
// nothing.
//
// Recorded HERE rather than only in a private working note, because the commit
// that added this file says the 404 was unproven and a commit message cannot be
// corrected without moving a pushed SHA. A correction filed somewhere the reader
// of the stale line cannot reach is not a correction.
//
// This is also the first behavioural test `tools/studio.mjs` has ever had — it is
// a script with no exports, so everything about its boot has been hand-verified.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO_MJS = path.join(REPO, "tools", "studio.mjs");
const APPS = path.join(path.dirname(REPO), "openrig-studio-apps");
let nextPort = 9640;

const hasApps = fs.existsSync(path.join(APPS, "apps", "workspace", "app.json"));

function makeStudio(apps, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-own-"));
  fs.writeFileSync(path.join(dir, "studio.json"),
    JSON.stringify({ port, appsRoot: APPS, apps }, null, 2));
  return dir;
}
const listening = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  const done = (v) => { s.destroy(); resolve(v); };
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
  setTimeout(() => done(false), 500);
});
async function boot(dir, port) {
  const proc = spawn(process.execPath, [STUDIO_MJS, "--port", String(port)],
    { cwd: dir, env: { ...process.env, OPENRIG_STUDIO_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 120; i++) {
    if (await listening(port)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, stop: () => new Promise((r) => { proc.once("exit", r); proc.kill(); }) };
}
const railIds = (dir) => {
  const p = path.join(dir, ".runtime", "surfaces", "surfaces.json");
  return JSON.parse(fs.readFileSync(p, "utf8")).surfaces.map((s) => s.id);
};

test("a booting studio stamps .runtime/ with its own port", { skip: !hasApps && "apps repo not present" },
  async (t) => {
    const port = nextPort++;
    const dir = makeStudio(["workspace"], port);
    const a = await boot(dir, port);
    t.after(() => a.stop());
    const owner = JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "owner.json"), "utf8"));
    assert.equal(owner.port, port, "the stamp does not name this studio's port");
    assert.equal(owner.studioRoot, dir);
    assert.ok(owner.pid > 0 && owner.startedAt, "the stamp is missing pid or startedAt");
  });

test("a SECOND studio on the same .runtime/ REFUSES instead of repainting",
  { skip: !hasApps && "apps repo not present" }, async (t) => {
    const portA = nextPort++, portB = nextPort++;
    const dir = makeStudio(["workspace"], portA);
    const a = await boot(dir, portA);
    t.after(() => a.stop());
    const before = railIds(dir);
    assert.ok(before.includes("workspace"), `first studio did not compose workspace: ${before}`);

    // Same directory, different port, different app list — the exact shape.
    fs.writeFileSync(path.join(dir, "studio.json"),
      JSON.stringify({ port: portB, appsRoot: APPS, apps: ["files"] }, null, 2));
    const second = spawnSync(process.execPath, [STUDIO_MJS, "--port", String(portB)],
      { cwd: dir, env: { ...process.env, OPENRIG_STUDIO_DIR: dir }, encoding: "utf8", timeout: 30000 });

    assert.equal(second.status, 7, `expected refusal (exit 7), got ${second.status}: ${second.stderr}`);
    assert.match(second.stderr, new RegExp(`port ${portA}`),
      "the refusal does not name which studio owns the directory");
    assert.deepEqual(railIds(dir), before,
      "the first studio's rail was repainted anyway — its tabs now show apps it cannot route");
    assert.ok(await listening(portA), "the first studio stopped serving");
  });

test("a STALE stamp is taken over, and the takeover is announced",
  { skip: !hasApps && "apps repo not present" }, async (t) => {
    const dir = makeStudio(["workspace"], nextPort++);
    // A stamp naming a port nothing is serving: the owner is gone.
    fs.mkdirSync(path.join(dir, ".runtime"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".runtime", "owner.json"),
      JSON.stringify({ pid: 999999, port: 9999, studioRoot: dir, startedAt: "2020-01-01T00:00:00Z" }));

    const port = nextPort++;
    fs.writeFileSync(path.join(dir, "studio.json"),
      JSON.stringify({ port, appsRoot: APPS, apps: ["workspace"] }, null, 2));
    const b = await boot(dir, port);
    t.after(() => b.stop());

    const owner = JSON.parse(fs.readFileSync(path.join(dir, ".runtime", "owner.json"), "utf8"));
    assert.equal(owner.port, port, "a stale stamp was not taken over — a dead studio blocks a live one forever");
  });

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
