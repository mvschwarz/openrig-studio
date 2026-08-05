// The annotations verb, its scoping, and the sub-context seam.
//
//   node --test 'test/*.test.mjs'
//
// The layer's own behaviour is browser work and lives in
// test/annotations-feature.test.mjs plus a live LOOK. What is pinned here is the
// part a browser cannot show you cheaply: that a scope genuinely isolates one
// board from another, that a forgotten parameter fails toward EMPTY rather than
// toward someone else's marks, and that a file-backed runtime actually reloads
// what it wrote.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let nextPort = 9610;

async function start({ file } = {}) {
  const port = nextPort++;
  const args = [path.join(REPO, "app", "serve-studio.mjs"), "--port", String(port)];
  if (file) args.push("--annotations", file);
  const proc = spawn(process.execPath, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/contract`, { cache: "no-store" }); break; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return {
    base,
    stop: () => new Promise((r) => { proc.once("exit", r); proc.kill(); }),
    read: async (scope) =>
      (await fetch(`${base}/api/annotations${scope === undefined ? "" : `?scope=${encodeURIComponent(scope)}`}`,
        { cache: "no-store" })).json(),
    write: async (body) => {
      const res = await fetch(`${base}/api/annotations`, { method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    contract: async () => (await fetch(`${base}/api/contract`, { cache: "no-store" })).json(),
  };
}

const mark = (note) => ({ id: `m-${note}`, surfaceId: "canvas", selector: "#publish", shape: "circle",
  note, source: "human", anchor: { x: .1, y: .1, width: .2, height: .1 }, status: "anchored" });

test("positive control: a fresh runtime answers a scope it has never seen", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  assert.deepEqual(await s.read("canvas"), { ok: true, scope: "canvas", records: [] });
});

test("marks round-trip through the verb verbatim", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const records = [mark("tighten this"), mark("and this")];
  const written = await s.write({ scope: "canvas", records });
  assert.equal(written.status, 200);
  assert.deepEqual((await s.read("canvas")).records, records,
    "what came back is not what was written — the runtime is reshaping marks it is supposed to store opaquely");
});

test("A SUB-CONTEXT IS A DIFFERENT BOARD, which is the whole point of the seam", async (t) => {
  // The migration regression this exists to prevent: ARTIFACTS holds many pages
  // behind ONE surface id. Keyed on the id alone, page 1's marks hang over page 2.
  const s = await start();
  t.after(() => s.stop());
  const NUL = String.fromCharCode(0);

  await s.write({ scope: "artifacts", records: [mark("default board")] });
  await s.write({ scope: `artifacts${NUL}page-2`, records: [mark("page two only")] });

  assert.deepEqual((await s.read("artifacts")).records.map((r) => r.note), ["default board"]);
  assert.deepEqual((await s.read(`artifacts${NUL}page-2`)).records.map((r) => r.note), ["page two only"],
    "a sub-context saw the default board's marks — the scopes are not isolated");

  // The discriminating half: an UNRELATED context must be empty rather than
  // inheriting either of the above. Without this, a store that ignored the
  // context suffix entirely would pass the two assertions above.
  assert.deepEqual((await s.read(`artifacts${NUL}page-3`)).records, [],
    "an undeclared sub-context inherited marks — the suffix is being ignored");
});

test("a read that FORGOT the scope answers empty, never everything", async (t) => {
  // The failure this forbids is not an error, it is a plausible wrong answer:
  // another surface's marks rendered over this one.
  const s = await start();
  t.after(() => s.stop());
  await s.write({ scope: "canvas", records: [mark("somebody else's")] });

  const bare = await s.read(undefined);
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.records, [], "a scope-less read returned marks belonging to a scope it did not ask for");
  assert.equal(bare.scope, null);
});

test("malformed writes are refused BY NAME rather than silently doing nothing", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  const noScope = await s.write({ records: [] });
  assert.equal(noScope.status, 400);
  assert.match(noScope.body.error, /scope/, "the refusal does not say what was missing");

  const noRecords = await s.write({ scope: "canvas" });
  assert.equal(noRecords.status, 400);
  assert.match(noRecords.body.error, /records/);

  const notJson = await s.write("not json at all");
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /JSON/);

  // And a refusal must not have written anything.
  assert.deepEqual((await s.read("canvas")).records, [],
    "a refused write still mutated the board");
});

test("persistence is REPORTED, and the report matches how it was started", async (t) => {
  const plain = await start();
  t.after(() => plain.stop());
  const before = (await plain.contract()).annotations;
  assert.deepEqual(before, { persistence: "memory", scopes: 0, writes: 0 });

  await plain.write({ scope: "canvas", records: [mark("one")] });
  const after = (await plain.contract()).annotations;
  assert.equal(after.persistence, "memory");
  assert.equal(after.scopes, 1);
  assert.equal(after.writes, 1, "the write counter is not measuring writes");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ann-"));
  const filed = await start({ file: path.join(dir, "marks.json") });
  t.after(() => filed.stop());
  assert.equal((await filed.contract()).annotations.persistence, "file",
    "a runtime started with --annotations still reports memory, so the UI will say 'session only' over marks that ARE persisted");
});

test("a file-backed runtime RELOADS what it wrote — the half that is easy to miss", async (t) => {
  // Writing to disk and reading it back in the same process proves nothing about
  // the load path. The claim is that marks survive a RESTART, so this restarts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ann-"));
  const file = path.join(dir, "nested", "marks.json");

  const first = await start({ file });
  await first.write({ scope: "canvas", records: [mark("survives")] });
  await first.stop();

  assert.ok(fs.existsSync(file), "nothing was written to the configured file");

  const second = await start({ file });
  t.after(() => second.stop());
  assert.deepEqual((await second.read("canvas")).records.map((r) => r.note), ["survives"],
    "a restarted runtime lost marks it had persisted — the write path works and the load path does not");
});

test("negative control: a MEMORY runtime genuinely loses them, so the test above means something", async (t) => {
  const first = await start();
  await first.write({ scope: "canvas", records: [mark("gone")] });
  await first.stop();

  const second = await start();
  t.after(() => second.stop());
  assert.deepEqual((await second.read("canvas")).records, [],
    "an unconfigured runtime persisted marks anyway — then the survival test above cannot distinguish file from memory");
});

test("the annotations verbs are NOT reserved — stored marks are data on the box", async (t) => {
  // The retraction from the focus/drive slice, applied forward rather than
  // relearned. focus and drive answer state held in THIS process and nothing else
  // can answer them. Marks are storage: a real studio should be able to keep them
  // in its own database, exactly as it serves its own real directories.
  const src = fs.readFileSync(path.join(REPO, "tools", "studio.mjs"), "utf8");
  const m = src.match(/const SDK_OWNED = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "tools/studio.mjs no longer declares SDK_OWNED — this test cannot find what it checks");
  const reserved = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(!reserved.includes("/api/annotations"),
    "reserving /api/annotations forbids the substitution that is the point of a provider");
});

test("only the ACTIVE surface may move the scope — STRUCTURAL, and it says so", () => {
  // HONEST ABOUT WHAT THIS IS: a structural check on shell.html, not a behavioural
  // one. The SDK has no browser dependency, so the real guard was verified by
  // driving a live shell; this exists so that REMOVING the guard fails the suite
  // rather than only failing a LOOK nobody re-runs.
  //
  // The property: a backgrounded surface still holds a live channel, so without
  // an e.source check the scope would follow whichever surface spoke last rather
  // than the one on screen — and the marks board would swap under the user.
  const shell = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");
  const handler = shell.match(/if \(e\.data\.t === "annotation-context"\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(handler, "shell.html no longer handles annotation-context — this test cannot find what it checks");
  assert.match(handler[1], /e\.source === current\.contentWindow/,
    "the annotation-context handler accepts a message without checking it came from the ACTIVE surface");
});

test("positive control: the guard check above can fail", () => {
  // The check is a regex over prose-adjacent source, which is exactly the shape
  // that silently matches nothing. Proven against a mutated copy rather than
  // trusted: same reason the leak sweep needed a live control.
  const shell = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");
  const stripped = shell.replace(/e\.source === current\.contentWindow/g, "true");
  const handler = stripped.match(/if \(e\.data\.t === "annotation-context"\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(handler, "the mutation broke the extractor rather than the guard — the control proves nothing");
  assert.doesNotMatch(handler[1], /e\.source === current\.contentWindow/,
    "the guard survived being removed, so the test above would pass with no guard at all");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
