// A rig's roster: every rig on the box by declaration ("*"), an honest "unreachable" when the rig can't be read, and a
// refresh that keeps the sidebar current without emptying it on a blip.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRig,
  resolveRoster,
  rigNodeArgs,
  createRosterRefresh,
  ALL_RIGS,
  UNREACHABLE,
} from "../tools/seat-roster.mjs";

const node = (seat, status = "running") => ({
  canonicalSessionName: seat,
  logicalId: seat.split("@")[0],
  sessionStatus: status,
});

test('"rig": "*" is every rig on the box, by declaration only', () => {
  assert.deepEqual(
    resolveRig({ declaredRig: "*", whoamiRig: "one", rigsOnBox: ["one", "two"] }).rig,
    ALL_RIGS,
  );
  assert.deepEqual(rigNodeArgs(ALL_RIGS), ["-A"]);
  assert.deepEqual(rigNodeArgs("one"), ["--rig", "one"]);
  const r = resolveRoster({ nodes: [node("a@one"), node("b@two", "exited")], rig: ALL_RIGS });
  assert.equal(r.seats.length, 2);
  assert.match(r.note, /every rig on this box \(1 running\)/);
});

test("a rig that can't be read is UNREACHABLE, not a rig with no seats", () => {
  const r = resolveRoster({ nodes: { error: "timed out" }, rig: "one" });
  assert.equal(r.source, UNREACHABLE);
  assert.deepEqual(r.seats, []);
  assert.match(r.note, /rig one unreachable: timed out/);
  // A declaration still wins entire.
  assert.equal(
    resolveRoster({ declared: [], nodes: { error: "x" }, rig: "one" }).source,
    "declared",
  );
});

test("the refresh rewrites the roster only when it changes, and keeps the last good one while the rig is unreachable", async () => {
  const answers = [
    [node("a@one")],
    { error: "timed out" },
    { error: "timed out" },
    [node("a@one"), node("b@one")],
    [node("a@one"), node("b@one")],
  ];
  const writes = [];
  const logs = [];
  const asked = [];
  const refresh = createRosterRefresh({
    rig: "one",
    read: async (args) => (asked.push(args), answers.shift()),
    write: (seats) => writes.push(seats.map((s) => s.seat)),
    initial: [{ seat: "a@one", name: "a", status: "running" }],
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await refresh(), { changed: false, source: "rig" });
  assert.deepEqual(await refresh(), { changed: false, source: UNREACHABLE });
  await refresh();
  assert.equal(logs.filter((m) => /unreachable/.test(m)).length, 1, "said once, not every minute");
  assert.match(logs[0], /keeping the last good roster \(1 seat\(s\)\)/);
  assert.deepEqual(await refresh(), { changed: true, source: "rig" });
  assert.deepEqual(writes, [["a@one", "b@one"]]);
  assert.deepEqual(await refresh(), { changed: false, source: "rig" });
  assert.deepEqual(asked[0], ["--rig", "one"]);
  // A read that throws counts as unreachable too.
  const r2 = createRosterRefresh({
    rig: "one",
    read: async () => {
      throw new Error("boom");
    },
    write: () => assert.fail("no write"),
  });
  assert.equal((await r2()).source, UNREACHABLE);
});
