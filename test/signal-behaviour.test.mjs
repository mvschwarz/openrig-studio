// Controls for the change-signal helper's behaviour.
//
//   node --test 'test/*.test.mjs'
//
// The helper takes its fetch as a parameter precisely so these can run without a
// browser and without a server. Each case pins a decision that had a plausible
// alternative, and several exist because the alternative is what the reference
// implementations actually did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { watchSignal, preserveAcross, deferWhileDirty, declaredKinds, preserveDeclared } from "../app/signal.js";

// A scripted transport. Each entry is one response, consumed in order.
function transport(script) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const next = script.shift();
      if (!next) return { ok: true, json: async () => ({}) };
      if (next.throw) throw new Error(next.throw);
      return { ok: next.ok !== false, status: next.status ?? 200, json: async () => next.body };
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("a change is detected via the SERVER marker, not a client-computed signature", async () => {
  // The degenerate case this replaces: the one implementation that computes its
  // own signature refetches unconditionally and still misses changes, because
  // its signature omits fields. A server marker moves whenever the server says
  // it moved — including for a change the client cannot see in the payload.
  const seen = [];
  const t = transport([
    { body: { runtime: { boot: "b1" } } },
    { body: { changed: false, marker: "m1", items: ["a"] } },
    { body: { runtime: { boot: "b1" } } },
    // Payload IDENTICAL. A client-side signature over `items` would compute the
    // same value and report nothing; the marker moved, so this is a change.
    { body: { changed: true, marker: "m2", items: ["a"] } },
  ]);
  const w = watchSignal({ verbs: ["/api/x"], interval: 5, fetchImpl: t.fetchImpl, onData: (d) => seen.push(d.marker) });
  await settle(); await settle();
  w.stop();
  assert.deepEqual(seen, ["m2"], `expected exactly the marker move: ${JSON.stringify(seen)}`);
});

test("the cursor is sent back as ?since= so the server can answer 'nothing changed'", async () => {
  const t = transport([
    { body: { runtime: { boot: "b1" } } },
    { body: { changed: true, marker: "m1" } },
    { body: { runtime: { boot: "b1" } } },
    { body: { changed: false, marker: "m1" } },
  ]);
  const w = watchSignal({ verbs: ["/api/x"], interval: 5, fetchImpl: t.fetchImpl });
  await settle(); await settle();
  w.stop();
  const second = t.calls.filter((u) => u.startsWith("/api/x"))[1];
  assert.match(second, /since=m1/, `the cursor was not sent back: ${second}`);
});

test("process identity is latched on the FIRST observation even when that poll FAILED", async () => {
  // The measured bug this designs out: latching on the first SUCCESSFUL poll
  // means a restart straddling startup is invisible, because by the time a poll
  // succeeds it is already the new process and becomes the baseline.
  const codes = [];
  const t = transport([
    { throw: "provider not up yet" },              // first observation: FAILS
    { body: { changed: false, marker: "m1" } },
    { body: { runtime: { boot: "b2" } } },         // now reachable, different id
    { body: { changed: false, marker: "m1" } },
  ]);
  const w = watchSignal({ verbs: ["/api/x"], interval: 5, fetchImpl: t.fetchImpl, onCode: (c) => codes.push(c) });
  await settle(); await settle();
  w.stop();
  // Latched undefined on the failed first read, so the later real id is a CHANGE
  // rather than the baseline.
  assert.equal(codes.length, 1, `expected the straddling restart to be seen: ${JSON.stringify(codes)}`);
});

test("an UNCHANGED process identity never triggers a reload, however much data moves", async () => {
  // The positive control for the code path. Without it, an implementation that
  // reloaded on every tick would satisfy the restart test above.
  const codes = [];
  const t = transport([
    { body: { runtime: { boot: "b1" } } },
    { body: { changed: true, marker: "m1" } },
    { body: { runtime: { boot: "b1" } } },
    { body: { changed: true, marker: "m2" } },
  ]);
  const w = watchSignal({ verbs: ["/api/x"], interval: 5, fetchImpl: t.fetchImpl, onCode: (c) => codes.push(c) });
  await settle(); await settle();
  w.stop();
  assert.deepEqual(codes, [], "a data change triggered a page reload");
});

test("a failed poll is REPORTED, and recovery is reported too", async () => {
  // Every poll in both reference codebases is a bare catch, so a dead provider
  // looks exactly like a quiet one — which the contract already forbids.
  const states = [];
  const t = transport([
    { body: { runtime: { boot: "b1" } } },
    { throw: "provider is dead" },
    { body: { runtime: { boot: "b1" } } },
    { body: { changed: false, marker: "m1" } },
  ]);
  const w = watchSignal({ verbs: ["/api/x"], interval: 5, fetchImpl: t.fetchImpl, onDegraded: (d) => states.push(d.degraded) });
  await settle(); await settle();
  w.stop();
  assert.deepEqual(states, [true, false], `expected degraded then recovered: ${JSON.stringify(states)}`);
});

// ------------------------------------------------------------ preserve

function withSessionStorage(fn) {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try { return fn(store); } finally { delete globalThis.sessionStorage; }
}

test("declared state survives a reload, and WITHOUT the helper the same state is lost", () => {
  withSessionStorage(() => {
    const state = { scroll: 120, selection: ["a"], playhead: 4.5 };

    // With the helper: capture before the reload, restore after.
    const before = preserveAcross("demo", { capture: () => state });
    before.keep();
    let got = null;
    const after = preserveAcross("demo", { restore: (s) => { got = s; } });
    assert.equal(after.restored, true);
    assert.deepEqual(got, state);

    // The CONTROL, and without it this proves only that sessionStorage works:
    // a surface that does not adopt the helper has nothing to restore.
    const naive = preserveAcross("other-surface", { restore: () => { throw new Error("nothing should restore"); } });
    assert.equal(naive.restored, false, "state leaked to a surface that never captured any");
  });
});

test("a restored slot is consumed, so a later reload does not resurrect stale state", () => {
  withSessionStorage(() => {
    preserveAcross("demo", { capture: () => ({ n: 1 }) }).keep();
    assert.equal(preserveAcross("demo", { restore: () => {} }).restored, true);
    assert.equal(preserveAcross("demo", { restore: () => {} }).restored, false,
      "the slot restored twice — a stale view would come back on an unrelated reload");
  });
});

test("a corrupt slot does not stop the surface loading", () => {
  withSessionStorage((store) => {
    store.set("openrig.preserve.demo", "{ not json");
    assert.equal(preserveAcross("demo", { restore: () => {} }).restored, false);
  });
});

test("the restore SAYS it happened, once", () => {
  withSessionStorage(() => {
    const said = [];
    preserveAcross("demo", { capture: () => ({ n: 1 }) }).keep();
    preserveAcross("demo", { restore: () => {}, say: (m) => said.push(m) });
    assert.equal(said.length, 1, "a reload the user did not expect must still be legible as one");
    assert.match(said[0], /kept/);
  });
});

// ------------------------------------------------ the declaration, consumed

const served = (rows) => ({
  ok: true,
  json: async () => ({ surfaces: rows }),
});

test("a surface reads its OWN declared kinds out of the served manifest", async () => {
  // The link that turns a carried field into a consumed one. Asserted against
  // the served document, because that is what a surface actually sees.
  const r = await declaredKinds({
    surfaceId: "mine",
    fetchImpl: async () => served([
      { id: "other", preserve: ["playhead"] },
      { id: "mine", preserve: ["scroll", "selection"] },
    ]),
  });
  assert.deepEqual(r.kinds, ["scroll", "selection"], "read the wrong row's declaration");
  assert.equal(r.problem, null);
});

test("declaring nothing and having no row are DIFFERENT answers", async () => {
  // Collapsing them to [] hides a registration failure behind a deliberate
  // choice, and a surface can act on the difference.
  const declaredNothing = await declaredKinds({
    surfaceId: "mine", fetchImpl: async () => served([{ id: "mine" }]),
  });
  assert.deepEqual(declaredNothing.kinds, []);
  assert.equal(declaredNothing.found, true);
  assert.equal(declaredNothing.problem, null, "declaring nothing is not a problem");

  const noRow = await declaredKinds({
    surfaceId: "mine", fetchImpl: async () => served([{ id: "somebody-else" }]),
  });
  assert.equal(noRow.found, false, "a missing row read as a present one that declared nothing");
  assert.match(noRow.problem, /no row with id/);
});

test("a DECLARED but unusable preserve is reported, not read as an empty list", async () => {
  // The likeliest real mistake is a string instead of an array. Absence is
  // silent because the field is optional; a declaration that does nothing is not.
  const r = await declaredKinds({
    surfaceId: "mine", fetchImpl: async () => served([{ id: "mine", preserve: "scroll" }]),
  });
  assert.deepEqual(r.kinds, []);
  assert.match(r.problem, /must be an array/, "an unusable declaration passed as an empty one");
});

test("preserveDeclared captures exactly the declared kinds and restores them", () => {
  withSessionStorage(() => {
    const live = { scroll: 240, playhead: 12.5, untouched: "leave me" };
    const adapter = { get: (k) => live[k], set: (k, v) => { live[k] = v; } };

    preserveDeclared("demo", ["scroll", "playhead"], { adapter }).keep();
    live.scroll = 0; live.playhead = 0;                    // the reload
    preserveDeclared("demo", ["scroll", "playhead"], { adapter });

    assert.equal(live.scroll, 240, "a declared kind was not restored");
    assert.equal(live.playhead, 12.5);
    assert.equal(live.untouched, "leave me", "an UNdeclared value was written — the list is the boundary");
  });
});

test("a kind the adapter cannot handle is REPORTED, and the others still work", () => {
  // The over-restrictive-guard hazard: refusing everything would satisfy a
  // reporting test on its own. The positive half is what makes it meaningful.
  withSessionStorage(() => {
    const live = { scroll: 10 };
    const reported = [];
    const adapter = {
      supports: (k) => k === "scroll",
      get: (k) => live[k],
      set: (k, v) => { live[k] = v; },
    };
    preserveDeclared("demo", ["scroll", "telepathy"], { adapter, onUnsupported: (u) => reported.push(...u) }).keep();
    live.scroll = 0;
    preserveDeclared("demo", ["scroll", "telepathy"], { adapter, onUnsupported: () => {} });

    assert.deepEqual(reported, ["telepathy"], "an unkeepable declared kind was dropped silently");
    assert.equal(live.scroll, 10, "reporting the unsupported kind broke the supported one");
  });
});

test("preserveDeclared THROWS without an adapter rather than preserving nothing quietly", () => {
  // A preserve helper that silently preserved nothing is the exact failure the
  // declaration exists to avoid, so this fails loudly instead.
  assert.throws(() => preserveDeclared("demo", ["scroll"], {}), /needs an adapter/);
});

// ------------------------------------------------------------ human wins

test("a change offered while the human is mid-edit is DEFERRED, not applied and not dropped", () => {
  let dirty = true;
  const applied = [];
  const g = deferWhileDirty(() => dirty, (c) => applied.push(c));

  assert.equal(g.offer({ marker: "m1" }), "deferred");
  assert.deepEqual(applied, [], "an agent write overwrote work in progress");
  assert.equal(g.deferred, true);

  assert.equal(g.flush(), false, "flushed while still dirty");

  dirty = false;
  assert.equal(g.flush(), true);
  assert.deepEqual(applied, [{ marker: "m1" }], "the deferred change was dropped rather than applied later");
});

test("a change offered to a CLEAN surface applies immediately — the guard is not just a block", () => {
  const applied = [];
  const g = deferWhileDirty(() => false, (c) => applied.push(c));
  assert.equal(g.offer({ marker: "m1" }), "applied");
  assert.deepEqual(applied, [{ marker: "m1" }]);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
