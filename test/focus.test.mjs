// Controls for focus — what the user is looking at.
//
//   node --test 'test/*.test.mjs'
//
// Each case is one of the measured defects in the surveyed implementations, or
// the discriminating half that keeps the fix from over-correcting. The three
// defects, all measured rather than inferred: a write verb with no matching read,
// so nothing off the box could see focus at all; a second writer blanking the
// record; and a view change reporting nothing because the reporter dedupes on
// selection alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await (await fetch(`${base}/api/contract`)).json(); break; }
    catch {
      if (Date.now() > deadline) { proc.kill(); throw new Error("runtime never came up"); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    dir,
    read: async (since) => (await fetch(`${base}/api/focus${since === undefined ? "" : `?since=${encodeURIComponent(since)}`}`,
      { cache: "no-store" })).json(),
    write: async (patch) => (await fetch(`${base}/api/focus`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) })).json(),
    stop: () => proc.kill(),
  };
}

// Every file under a root — used to prove there is no record on disk to read.
const walk = (root, out = []) => {
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (fs.statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
};

test("focus is READABLE over HTTP — the defect was a write verb with no read", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  await s.write({ surface: "canvas", selection: ["shape-7"], view: { page: 2 }, by: "agent" });
  const got = await s.read();

  assert.equal(got.ok, true);
  assert.equal(got.focus.surface, "canvas");
  assert.deepEqual(got.focus.selection, ["shape-7"]);
  assert.deepEqual(got.focus.view, { page: 2 });
});

test("a consumer with NO filesystem access can still read it — there is no file to read", async (t) => {
  // The discriminating half of the item above, and the reason it matters: reading
  // the record off disk works only for a consumer on this machine, which excludes
  // every remote agent. Asserting "HTTP works" proves nothing on its own if a file
  // is also sitting there — so this asserts the file does NOT exist, which is what
  // makes the verb the only path rather than the convenient one.
  const s = await start();
  t.after(() => s.stop());
  await s.write({ surface: "canvas", selection: ["shape-7"], by: "agent" });

  const onDisk = walk(s.dir).filter((f) => /focus/i.test(path.basename(f)));
  assert.deepEqual(onDisk, [], `a focus record was written to disk: ${onDisk.join(", ")}`);

  // ...and the record is genuinely available over the verb, or the assertion
  // above would pass against a runtime that simply lost it.
  assert.deepEqual((await s.read()).focus.selection, ["shape-7"]);
});

test("a second writer cannot blank a field the first wrote", async (t) => {
  // THE MEASURED CLOBBER: one verb wrote the whole record, blanking `view` while
  // setting a selection — so pinning something destroyed the view context the
  // focus reporter had just written. Both writers were reasonable; the format
  // made them collide.
  const s = await start();
  t.after(() => s.stop());

  await s.write({ surface: "canvas", view: { page: 2 }, by: "reporter" });
  await s.write({ selection: ["shape-7"], by: "pinner" });

  const got = (await s.read()).focus;
  assert.deepEqual(got.view, { page: 2 }, "the second writer blanked the view it had no opinion about");
  assert.deepEqual(got.selection, ["shape-7"], "the second writer's own field did not land");
  assert.equal(got.surface, "canvas", "an untouched field was lost");
});

test("a field IS cleared when a write names it null — scoped, not merely additive", async (t) => {
  // The over-correction to avoid. A record that can never clear a field is as
  // broken as one that clears them by accident; the difference is whether the
  // caller SAID so. Without this, "nothing was blanked" passes against a runtime
  // that ignores clears entirely.
  const s = await start();
  t.after(() => s.stop());

  await s.write({ surface: "canvas", view: { page: 2 }, by: "a" });
  await s.write({ view: null, by: "a" });

  assert.equal((await s.read()).focus.view, null, "an explicit null did not clear the field");
});

test("a VIEW change with an UNCHANGED selection is reported as a change", async (t) => {
  // The surveyed reporter dedupes on selection alone, so moving to another page
  // or board reports nothing — the user has plainly changed what they are looking
  // at and the agent is told nothing.
  const s = await start();
  t.after(() => s.stop());

  await s.write({ surface: "canvas", selection: ["shape-7"], view: { page: 2 }, by: "a" });
  const before = (await s.read()).marker;

  await s.write({ view: { page: 3 }, by: "a" });          // selection untouched
  const after = await s.read(before);

  assert.equal(after.changed, true, "a view change with an unchanged selection reported nothing");
  assert.notEqual(after.marker, before, "the marker did not move for a real change");
  assert.deepEqual(after.focus.selection, ["shape-7"], "the selection was disturbed by a view write");
});

test("an unchanged record reports changed:false — so the marker is not always-moving", async (t) => {
  // The positive control for the case above. A marker that changed on every read
  // would satisfy it while making the signal useless.
  const s = await start();
  t.after(() => s.stop());

  await s.write({ surface: "canvas", view: { page: 2 }, by: "a" });
  const m = (await s.read()).marker;
  const again = await s.read(m);

  assert.equal(again.changed, false, "the marker moved without anything changing");
  assert.equal(again.marker, m);
});

test("selection is carried as its SURFACE means it, with no universal schema imposed", async (t) => {
  // Across the surveyed applications selection is asset names, opaque shape ids,
  // absolute paths and slot ids. A record that coerced them to one shape would be
  // right for one application and silently wrong for the rest, so each is
  // asserted to round-trip verbatim alongside the surface that gives it meaning.
  const s = await start();
  t.after(() => s.stop());

  const shapes = { surface: "canvas", selection: ["a1b2c3", "d4e5f6"] };
  const paths = { surface: "files", selection: ["/Users/someone/media/take-01.mov"] };
  const slots = { surface: "timeline", selection: [{ slot: 4, take: 2 }] };

  for (const sample of [shapes, paths, slots]) {
    await s.write({ ...sample, by: "a" });
    const got = (await s.read()).focus;
    assert.equal(got.surface, sample.surface, "the record must name the surface that gives selection meaning");
    assert.deepEqual(got.selection, sample.selection,
      `selection was not carried verbatim for ${sample.surface} — a schema was imposed on it`);
  }
});

test("at is server-set; a caller cannot dictate when focus last changed", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  await s.write({ surface: "canvas", at: "1999-01-01T00:00:00.000Z", by: "a" });
  const at = (await s.read()).focus.at;

  assert.notEqual(at, "1999-01-01T00:00:00.000Z", "the caller's timestamp was accepted");
  assert.ok(Date.now() - Date.parse(at) < 60_000, `at is not a fresh server timestamp: ${at}`);
});

test("a malformed write is refused by name rather than silently ignored", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  const notObject = await s.write(["not", "an", "object"]);
  assert.equal(notObject.ok, false);
  assert.match(notObject.error, /JSON object/);

  const noKnownField = await s.write({ nonsense: 1 });
  assert.equal(noKnownField.ok, false);
  assert.match(noKnownField.error, /named no known field/);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
