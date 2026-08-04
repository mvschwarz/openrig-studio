// Controls for the agent-sidebar roster.
//
//   node --test 'test/*.test.mjs'
//
// Each case is one of the three measured defects, or the discriminator that
// keeps a fix from over-correcting. The empty-declaration case is the one to
// read first: it is the difference between "this app ships without seats" and
// "nothing was declared", and treating them the same is how the SDK's invented
// fixture seat reached real boxes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoster, resolveRig, DECLARED, RIG, NONE } from "../tools/seat-roster.mjs";

// Invented rig and seat names. Real handles from the machine that wrote a test
// do not belong in a public package — that is the same leak the scaffolder's
// .gitignore fix exists to stop, one layer over, and a fixture is where it is
// easiest to not notice.
const nodes = [
  { logicalId: "alpha.impl", rigName: "example-rig", canonicalSessionName: "alpha-impl@example-rig", sessionStatus: "running" },
  { logicalId: "alpha.qa", rigName: "example-rig", canonicalSessionName: "alpha-qa@example-rig", sessionStatus: "detached" },
  { logicalId: "beta.review", rigName: "example-rig", canonicalSessionName: "beta-review@example-rig", sessionStatus: "exited" },
];

test("an explicit roster wins entire", () => {
  const r = resolveRoster({ declared: [{ seat: "a@r", name: "a" }], nodes, rig: "example-rig" });
  assert.equal(r.source, DECLARED);
  assert.deepEqual(r.seats.map((s) => s.seat), ["a@r"], "the rig roster overrode an explicit declaration");
});

test("an EMPTY explicit roster is a declaration, not an absence", () => {
  // The defect that leaked the fixture: the writer tested `chatSeats?.length`,
  // so [] meant "nothing declared", the key was omitted from the overlay, and
  // the runtime fell through to the package document.
  const r = resolveRoster({ declared: [], nodes, rig: "example-rig" });
  assert.equal(r.source, DECLARED);
  assert.deepEqual(r.seats, [], "an app that ships without seats got the rig's roster instead");
});

test("with no declaration the rig supplies the roster, INCLUDING members that are not running", () => {
  // Roster membership and liveness are different claims. Dropping the stopped
  // ones would make the sidebar shrink silently when something crashes.
  const r = resolveRoster({ declared: undefined, nodes, rig: "example-rig" });
  assert.equal(r.source, RIG);
  assert.deepEqual(r.seats.map((s) => s.status), ["running", "detached", "exited"]);
  assert.match(r.note, /3 seat\(s\) from rig example-rig \(1 running\)/,
    `the note must not call them all live: ${r.note}`);
});

test("no rig and no declaration yields an EMPTY roster, never the package fixture", () => {
  const r = resolveRoster({ declared: undefined, nodes: [], rig: null, ambiguity: "no rig on this box" });
  assert.equal(r.source, NONE);
  assert.deepEqual(r.seats, []);
});

test("rows without a usable seat name are dropped rather than rendered broken", () => {
  const r = resolveRoster({ declared: undefined, rig: "r", nodes: [{ logicalId: undefined, rigName: undefined }] });
  assert.deepEqual(r.seats, []);
});

// ------------------------------------------------------------- rig selection

test("an explicitly declared rig beats an inferred one", () => {
  const r = resolveRig({ declaredRig: "mine", whoamiRig: "other", rigsOnBox: ["a", "b"] });
  assert.equal(r.rig, "mine");
});

test("inside a managed session the current rig is used", () => {
  assert.equal(resolveRig({ whoamiRig: "example-rig", rigsOnBox: ["a", "b"] }).rig, "example-rig");
});

test("one rig on the box is unambiguous and is used", () => {
  assert.equal(resolveRig({ rigsOnBox: ["only-one"] }).rig, "only-one");
});

test("SEVERAL rigs and nothing declared REFUSES — it does not union or pick the first", () => {
  // The measured behaviour this replaces: the launcher unioned 12 rigs and the
  // shell opened on whichever sorted first. That is not discovery.
  const r = resolveRig({ rigsOnBox: ["rig-one", "rig-two", "rig-three"] });
  assert.equal(r.rig, null);
  assert.match(r.why, /3 rigs/);
  assert.match(r.why, /rig-two/, "the refusal must name the candidates so the operator can pick");
});

test("no rigs at all is an honest empty, not an error", () => {
  assert.equal(resolveRig({ rigsOnBox: [] }).rig, null);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
