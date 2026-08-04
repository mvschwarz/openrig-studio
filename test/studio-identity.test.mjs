// Controls for the provisioner's reuse decision.
//
//   node --test 'test/*.test.mjs'
//
// Slice 04's proof contract, items 3-5. The cases are review-r1's, and the last
// one is the reason the others are not enough: an over-restrictive guard and a
// correct one produce an identical row of refusals, so refusing every hostile
// input proves nothing on its own. The positive case is what separates "checks
// identity" from "never reuses anything".

import { test } from "node:test";
import assert from "node:assert/strict";
import { reuseDecision, REUSE, NOT_MINE } from "../provision/studio-identity.mjs";

const MINE = "/home/op/studio/.runtime/surfaces";

const studio = (dir) => JSON.stringify({
  contractVersion: "0.1",
  runtime: { name: "openrig-studio", flavor: "reference-fixture" },
  capabilities: ["contract.meta", "observe.factory-state", "stream.events", "files.read", "shell.protocol"],
  manifest: {
    ok: true, errors: [], warnings: [], surfaces: 1,
    consumer: dir === null ? null : { dir, surfaces: 1, state: "ok" },
  },
});

test("a studio serving THIS run's directory is reused", () => {
  // THE POSITIVE CONTROL, and it is the load-bearing one. Every other case here
  // refuses; a guard that refused unconditionally would pass all of them and
  // ship a provisioner that can never reuse anything.
  const d = reuseDecision({ body: studio(MINE), expectedDir: MINE });
  assert.equal(d.outcome, REUSE, d.reason);
  assert.match(d.reason, /reusing it/);
});

test("a studio serving a DIFFERENT directory is refused, and both paths are named", () => {
  // r1's sibling-studio case: the one that produced a green run against the
  // wrong studio's surfaces.
  const theirs = "/home/op/other-studio/.runtime/surfaces";
  const d = reuseDecision({ body: studio(theirs), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.ok(d.reason.includes(theirs) && d.reason.includes(MINE),
    `the refusal must name what it found AND what it wanted: ${d.reason}`);
});

test("r1's squatter — 200 on /api/contract with a body that is not a studio — is refused", () => {
  const d = reuseDecision({ body: JSON.stringify({ totally: "not a studio" }), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /no studio contract/);
});

test("a server answering with something that is not JSON at all is refused", () => {
  const d = reuseDecision({ body: "<html>hello</html>", expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /did not return JSON/);
});

test("a ZERO-CONFIG studio is refused — it is a studio, but it cannot be this one", () => {
  // The discriminating middle case. A zero-config studio is genuinely a studio
  // and answers every field r1 named, so a check that looked only for "is this a
  // studio" would adopt it. It serves no overlay, so it cannot be the studio
  // this run installed.
  const d = reuseDecision({ body: studio(null), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
  assert.match(d.reason, /no overlay configured/);
});

test("a contract response missing manifest entirely is refused, not crashed on", () => {
  const d = reuseDecision({ body: JSON.stringify({ contractVersion: "0.1" }), expectedDir: MINE });
  assert.equal(d.outcome, NOT_MINE);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
