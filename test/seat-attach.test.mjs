// Controls for the seat-terminal AUTHORIZATION boundary.
//
//   node --test 'test/*.test.mjs'
//
// `?arg=<seat>` is caller-controlled. The sidebar only SUGGESTS a roster, so
// narrowing what the shell renders is not a boundary — a two-rig inventory showed that
// after the launcher was scoped to one rig, the attach script still authorized
// against `rig ps --nodes -A`, and a seat belonging to a DIFFERENT rig passed
// the allowlist and failed only later at tmux resolution.
//
// So authorization reads the composed overlay manifest the shell is served from:
// the same artifact, not a second query that ought to agree. These assert on the
// REASON, because an on-roster seat also fails on this host — there is no live
// tmux session for a fictional seat — and "it exited non-zero" would pass for
// both the authorized and the unauthorized case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "seat-attach.sh");

function roster(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-attach-"));
  const f = path.join(dir, "surfaces.json");
  fs.writeFileSync(f, JSON.stringify(doc));
  return f;
}

const attach = (seat, seatsPath) => spawnSync("bash", [SCRIPT, seat], {
  encoding: "utf8",
  env: { ...process.env, OPENRIG_STUDIO_SEATS: seatsPath ?? "" },
});

const ONE_RIG = { chatSeats: [{ seat: "a-impl@rig-one", name: "a.impl", status: "running" }] };

test("a seat from ANOTHER rig is refused at the roster boundary", () => {
  // The discriminating case. Before this it passed the allowlist.
  const r = attach("b-impl@rig-two", roster(ONE_RIG));
  assert.match(r.stdout, /not on this studio's roster/,
    `a foreign seat got past authorization: ${r.stdout}`);
  assert.notEqual(r.status, 0);
});

test("an on-roster seat PASSES authorization and fails later, for a different reason", () => {
  // The positive control. Without it, a script that refused everything would
  // satisfy every other case here and ship a terminal that can never attach.
  const r = attach("a-impl@rig-one", roster(ONE_RIG));
  assert.doesNotMatch(r.stdout, /not on this studio's roster/,
    "a seat that IS on the roster was refused by the allowlist");
  assert.match(r.stdout, /no live session to attach to/,
    `expected to reach tmux resolution: ${r.stdout}`);
});

test("no roster path authorizes nothing", () => {
  const r = attach("a-impl@rig-one", "");
  assert.match(r.stdout, /no composed roster available/);
  assert.notEqual(r.status, 0);
});

test("a missing roster FILE authorizes nothing", () => {
  const r = attach("a-impl@rig-one", path.join(os.tmpdir(), "definitely-absent-roster.json"));
  assert.match(r.stdout, /no composed roster available/);
});

test("a malformed roster authorizes nothing rather than throwing it open", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-attach-bad-"));
  const f = path.join(dir, "surfaces.json");
  fs.writeFileSync(f, "{ not json");
  assert.match(attach("a-impl@rig-one", f).stdout, /not on this studio's roster/);
});

test("an EMPTY roster authorizes nothing — a studio with no seats attaches none", () => {
  assert.match(attach("a-impl@rig-one", roster({ chatSeats: [] })).stdout, /not on this studio's roster/);
});

test("an empty seat argument is refused before anything else", () => {
  const r = attach("", roster(ONE_RIG));
  assert.match(r.stdout, /no seat requested/);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
