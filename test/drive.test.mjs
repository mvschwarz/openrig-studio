// Controls for drive — the agent operating the surface.
//
//   node --test 'test/*.test.mjs'
//
// The mechanism is a port of one proven in a real application: POST an op, a
// generation counter, latest intent wins, the open page follows. What is asserted
// here is the part a port most easily loses — that superseded intent is DROPPED
// rather than replayed, and that two applications never overlap. Both failures
// leave a surface looking healthy while showing something nobody asked for, which
// is the shape that survives review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { driveSurface } from "../app/signal.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drive-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  const port = await freePort();
  const proc = spawn(
    process.execPath,
    [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port)],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  );
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await (await fetch(`${base}/api/contract`)).json();
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error("runtime never came up");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // Ops are per-surface now: POST carries { surface, ...intent }, GET addresses
  // ?surface=<id>. The single-surface tests use a fixed default id "s"; the
  // per-surface control drives distinct ids.
  const post = (body) =>
    fetch(`${base}/api/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const get = (surface, params = {}) => {
    const q = new URLSearchParams({ surface, ...params });
    return fetch(`${base}/api/drive?${q}`, { cache: "no-store" }).then((r) => r.json());
  };
  return {
    dir,
    base,
    drive: async (op, surface = "s") => post({ surface, ...op }),
    driveTo: async (surface, op) => post({ surface, ...op }),
    postRaw: async (body) => post(body),
    read: async (since, surface = "s") => get(surface, since === undefined ? {} : { since }),
    readAt: async (surface, params = {}) => get(surface, params),
    stop: () => proc.kill(),
  };
}

test("an op posted by an agent is readable by the surface, verbatim", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  await s.drive({ show: "take-3", say: "showing the third take" });
  const got = await s.read();

  assert.equal(got.ok, true);
  assert.equal(got.op.show, "take-3");
  assert.equal(got.op.say, "showing the third take");
});

test("the op is carried OPAQUELY — the runtime imposes no schema on intent", async (t) => {
  // The same decision as surface-typed `selection`, for the same reason: what an
  // op MEANS is the surface's business. A runtime that validated op shapes would
  // be right for one application and would block every other one, and it would
  // quietly become a second renderer.
  const s = await start();
  t.after(() => s.stop());

  const odd = { nested: { deep: [1, 2, { k: "v" }] }, unicode: "café ▲", "weird key": true };
  await s.drive(odd);
  const got = (await s.read()).op;

  for (const [k, v] of Object.entries(odd)) {
    assert.deepEqual(
      got[k],
      v,
      `the runtime altered or dropped an op field it does not understand: ${k}`,
    );
  }
});

test("the marker moves on every op, and NOT otherwise", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  await s.drive({ a: 1 });
  const first = (await s.read()).marker;

  const unchanged = await s.read(first);
  assert.equal(unchanged.changed, false, "the marker moved with no new op");
  assert.equal(unchanged.marker, first);

  await s.drive({ a: 2 });
  const after = await s.read(first);
  assert.equal(after.changed, true, "a new op did not report as a change");
  assert.notEqual(after.marker, first, "the marker did not move for a real op");
});

test("a runtime nobody has driven answers a null op rather than an error", async (t) => {
  // Adopting this must not require anything to have driven the surface first.
  const s = await start();
  t.after(() => s.stop());

  const got = await s.read();
  assert.equal(got.ok, true);
  assert.equal(got.op, null, "an undriven runtime invented an op");
});

test("a malformed op is refused by name rather than silently accepted", async (t) => {
  const s = await start();
  t.after(() => s.stop());

  // A non-object body cannot carry a surface address, so it is refused by name
  // at the addressing gate (op-must-be-object is now defensive behind it).
  const arr = await s.postRaw(["not", "an", "object"]);
  assert.equal(arr.ok, false);
  assert.match(arr.error, /surface|JSON object/);
});

// ------------------------------------------------- the surface half

test("SUPERSEDED OPS ARE DROPPED, not replayed — the whole reason for a counter", async (t) => {
  // THE DEFECT THIS PREVENTS. With a queue, a page that is slow to apply falls
  // behind and then works through instructions that were true minutes ago,
  // animating through states nobody asked to see. It looks healthy the entire
  // time, which is what makes it survive review.
  const applied = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const d = driveSurface({
    surface: "s",
    apply: async (op) => {
      applied.push(op.gen);
      if (op.gen === 1) await gate;
    },
    fetchImpl: async () => ({
      json: async () => ({ ok: true, changed: false, marker: "x", op: null }),
    }),
  });
  t.after(() => d.stop());

  d.offer({ gen: 1 }); // starts, and blocks
  d.offer({ gen: 2 }); // superseded before it ever runs
  d.offer({ gen: 3 }); // supersedes 2
  release();
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(
    applied,
    [1, 3],
    `every op was applied in order instead of skipping superseded intent: ${applied.join(",")}`,
  );
});

test("an OLDER op arriving late is ignored — order is by generation, not arrival", async (t) => {
  const applied = [];
  const d = driveSurface({
    surface: "s",
    apply: (op) => {
      applied.push(op.gen);
    },
    fetchImpl: async () => ({
      json: async () => ({ ok: true, changed: false, marker: "x", op: null }),
    }),
  });
  t.after(() => d.stop());

  d.offer({ gen: 5 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.offer({ gen: 4 }), "superseded", "an op older than what is applied was accepted");
  assert.equal(d.offer({ gen: 5 }), "superseded", "the same op was applied twice");
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(applied, [5], `a stale or duplicate op was applied: ${applied.join(",")}`);
});

test("two applications never overlap — a mid-flight op waits rather than interleaving", async (t) => {
  // Concurrent applications interleave their writes and leave the surface in a
  // state NEITHER op described. Asserted by measuring overlap directly rather
  // than by trusting the ordering of the results.
  let inFlight = 0,
    maxConcurrent = 0;
  const d = driveSurface({
    surface: "s",
    apply: async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
    },
    fetchImpl: async () => ({
      json: async () => ({ ok: true, changed: false, marker: "x", op: null }),
    }),
  });
  t.after(() => d.stop());

  d.offer({ gen: 1 });
  d.offer({ gen: 2 });
  d.offer({ gen: 3 });
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(maxConcurrent, 1, `${maxConcurrent} applications ran at once — they interleave`);
});

test("positive control: the harness CAN observe an overlap", async () => {
  // Without this, the assertion above passes against a driver that never applies
  // anything at all — a measurement of nothing reads exactly like a measurement
  // of correct behaviour.
  let inFlight = 0,
    maxConcurrent = 0;
  const applyOverlapping = async () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
  };
  await Promise.all([applyOverlapping(), applyOverlapping()]);
  assert.equal(
    maxConcurrent,
    2,
    "the overlap detector cannot see concurrency, so the test above proves nothing",
  );
});

test("an op posted BEFORE the surface loaded is not replayed", async (t) => {
  // MEASURED IN A COLD BUILD: a brand-new page with no prior state applied an op
  // that had been posted before it existed, and showed that op's narration on
  // boot. Harmless for `select`; a side effect nobody asked for if the op is
  // `play`, `export` or `delete`, firing again in every new tab.
  const applied = [];
  const d = driveSurface({
    surface: "s",
    apply: (op) => {
      applied.push(op.gen);
    },
    intervalMs: 5,
    // The runtime keeps the last op forever, so a fresh surface always sees one.
    fetchImpl: async () => ({
      json: async () => ({ ok: true, changed: true, marker: "m1", op: { gen: 9, select: "x" } }),
    }),
  });
  t.after(() => d.stop());

  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(
    applied,
    [],
    `an op that predates the surface was applied: ${applied.join(",")}`,
  );
  assert.equal(
    d.accepted,
    9,
    "the baseline was not adopted, so a later op could not be told from this one",
  );
});

test("...but an op posted AFTER it loaded still applies — the baseline is not a mute button", async (t) => {
  // The discriminating half. Without it, "nothing was replayed" passes just as
  // happily against a surface that has stopped listening altogether, which would
  // break the primitive while looking like the fix.
  const applied = [];
  let current = { gen: 9, select: "old" };
  const d = driveSurface({
    surface: "s",
    apply: (op) => {
      applied.push(op.select);
    },
    intervalMs: 5,
    fetchImpl: async () => ({
      json: async () => ({ ok: true, changed: true, marker: "m", op: current }),
    }),
  });
  t.after(() => d.stop());

  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(applied, [], "precondition: the pre-existing op must not have applied");

  current = { gen: 10, select: "new" }; // the agent drives it NOW
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(applied, ["new"], "an op posted after load did not apply — the surface is deaf");
});

test("resumeLatestOnLoad opts back IN to catching up, for surfaces that want it", async (t) => {
  const applied = [];
  const d = driveSurface({
    surface: "s",
    apply: (op) => {
      applied.push(op.select);
    },
    intervalMs: 5,
    resumeLatestOnLoad: true,
    fetchImpl: async () => ({
      json: async () => ({ ok: true, changed: true, marker: "m", op: { gen: 9, select: "x" } }),
    }),
  });
  t.after(() => d.stop());

  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(applied, ["x"], "the opt-in did not resume the latest intent");
});

test("the poll survives the runtime going away", async (t) => {
  // A surface that stopped polling on the first failed request would need a manual
  // reload to become drivable again — the exact state this primitive removes.
  let calls = 0;
  const d = driveSurface({
    surface: "s",
    apply: () => {},
    intervalMs: 5,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("runtime is down");
    },
    onError: () => {},
  });
  t.after(() => d.stop());

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(calls >= 3, `polling stopped after ${calls} failed request(s)`);
});

test("end to end: an agent POSTs and an adopting surface applies it", async (t) => {
  // The claim the whole primitive makes, asserted against the real runtime rather
  // than a scripted transport.
  const s = await start();
  t.after(() => s.stop());

  const applied = [];
  const d = driveSurface({
    surface: "s",
    apply: (op) => {
      applied.push(op);
    },
    endpoint: `${s.base}/api/drive`,
    intervalMs: 20,
  });
  t.after(() => d.stop());

  // Let the surface take its baseline before driving it. THE RACE THIS AVOIDS IS
  // REAL AND IS DOCUMENTED IN drive.md, not a test artifact: an op posted in the
  // window between a surface loading and its first poll answering is treated as
  // pre-existing and skipped. The window is one poll interval, and it is the
  // unavoidable cost of a surface being unable to tell an op posted 2ms before it
  // existed from one posted an hour before. Racing it here would make the test
  // flaky about a property it is not trying to measure.
  await new Promise((r) => setTimeout(r, 60));

  await s.drive({ show: "take-3" });
  const deadline = Date.now() + 5000;
  while (!applied.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

  assert.equal(applied.length, 1, "the surface never received the op an agent posted");
  assert.equal(applied[0].show, "take-3");
});

// ---------------------------------------- per-surface delivery + settle-ack

test("PER-SURFACE DELIVERY: an op addressed to A never reaches kept-alive B or C", async (t) => {
  // The shell keeps backgrounded surfaces ALIVE and polling, so one global
  // channel would fan every op to all of them — including the play/export/delete
  // side-effect classes the contract names. The fixture MUST keep B and C alive:
  // that is the exact condition, and a fixture that closed them would prove
  // nothing.
  const s = await start();
  t.after(() => s.stop());

  const appliedA = [],
    appliedB = [],
    appliedC = [];
  const mk = (surface, sink) =>
    driveSurface({
      surface,
      apply: (op) => {
        sink.push(op);
      },
      endpoint: `${s.base}/api/drive`,
      intervalMs: 15,
    });
  const A = mk("A", appliedA),
    B = mk("B", appliedB),
    C = mk("C", appliedC);
  t.after(() => {
    A.stop();
    B.stop();
    C.stop();
  });

  await new Promise((r) => setTimeout(r, 80)); // all three take their baselines

  // Space the ops past a poll interval so each is applied before the next —
  // otherwise the generation counter correctly supersedes them down to the last
  // (that behaviour has its own test above; this control is about ADDRESSING).
  for (const op of [{ delete: "take-3" }, { export: "reel" }, { play: true }]) {
    await s.driveTo("A", op);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 120)); // well past several poll intervals

  assert.equal(
    appliedA.length,
    3,
    "A did not receive its own ops — per-surface delivery dropped them",
  );
  assert.deepEqual(
    appliedB,
    [],
    "a kept-alive B received an op addressed to A — delete/export/play fired on the wrong surface, the exact defect",
  );
  assert.deepEqual(appliedC, [], "a kept-alive C received an op addressed to A");
});

test("ADDRESSING IS MANDATORY: an unaddressed op is refused, so the fan-out default cannot return", async (t) => {
  // Q3 breaking-now: a warned unaddressed default still fans out. POST and GET
  // both refuse an unaddressed op by name.
  const s = await start();
  t.after(() => s.stop());

  const posted = await s.postRaw({ delete: "everything" }); // no surface
  assert.equal(posted.ok, false, "an unaddressed op was accepted — the fan-out default is back");
  assert.match(posted.error, /surface/);

  const polled = await fetch(`${s.base}/api/drive`, { cache: "no-store" }).then((x) => x.json());
  assert.equal(
    polled.ok,
    false,
    "an unaddressed poll was answered — a surface could receive another's ops",
  );
  assert.match(polled.error, /surface/);
});

test("SETTLE-ACK is BOUNDED: a future or foreign generation cannot be acked", async (t) => {
  // Negative control BEFORE the positive record-to-apply test. If the endpoint
  // accepted an arbitrary future `applied`, any caller knowing a surface id could
  // move appliedGen permanently ahead of every future op, closing the
  // record-to-apply gap with no apply. An ack must be bounded to a generation
  // actually RECORDED for that surface.
  const s = await start();
  t.after(() => s.stop());

  // A fresh slot, no op recorded: a future ack is ignored, appliedGen stays 0.
  const fresh = await s.readAt("A", { applied: "999999" });
  assert.equal(
    fresh.appliedGen,
    0,
    "a future ack on a fresh slot was accepted — appliedGen moved with no recorded op",
  );

  // Record gen 1; an ack ABOVE the recorded gen is still ignored.
  const posted = await s.driveTo("A", { play: true });
  assert.equal(posted.gen, 1);
  const over = await s.readAt("A", { applied: "999999" });
  assert.equal(over.appliedGen, 0, "an ack above the recorded generation was accepted");

  // A FOREIGN gen (recorded for another surface, since gen is global) is ignored.
  await s.driveTo("B", { play: true }); // gen 2, recorded for B not A
  const foreign = await s.readAt("A", { applied: "2" });
  assert.equal(
    foreign.appliedGen,
    0,
    "a generation recorded for another surface was acked on this one",
  );

  // The legitimate ack (a gen recorded for A) is accepted and monotonic.
  const ok = await s.readAt("A", { applied: "1" });
  assert.equal(ok.appliedGen, 1, "a valid ack of a recorded generation was refused");
  const back = await s.readAt("A", { applied: "0" });
  assert.equal(back.appliedGen, 1, "appliedGen went backwards — monotonicity lost");

  // THE INTERLEAVED DISCRIMINATOR: A=1, B=2, A=3. Gen 2 is
  // below A's latest recorded gen (3) but was NEVER recorded for A — membership,
  // not just an upper bound. Acking 2 on A must be refused; acking 3 (A's own)
  // accepted.
  await s.driveTo("A", { play: true }); // A now has gen 3 (B's gen 2 sits between)
  const interleaved = await s.readAt("A", { applied: "2" });
  assert.equal(
    interleaved.appliedGen,
    1,
    "gen 2 (recorded for B, below A's latest) was acked on A — monotonic+bounded is not membership",
  );
  const own = await s.readAt("A", { applied: "3" });
  assert.equal(own.appliedGen, 3, "A's own recorded generation 3 was refused");
});

test("SETTLE-ACK: appliedGen exposes a real posted-but-not-yet-applied window", async (t) => {
  // Q2 condition 3: the record-to-apply gap must be OBSERVABLE via appliedGen <
  // postedGen, or the ack is decoration. POST returns on RECORD; appliedGen only
  // advances when the surface's apply() has RESOLVED (the harder half).
  const s = await start();
  t.after(() => s.stop());

  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const d = driveSurface({
    surface: "A",
    endpoint: `${s.base}/api/drive`,
    intervalMs: 10,
    apply: async () => {
      await gate;
    }, // hold the application open
  });
  t.after(() => d.stop());
  await new Promise((r) => setTimeout(r, 50)); // baseline

  const posted = await s.driveTo("A", { play: true });
  assert.equal(posted.recorded, true, "POST did not report it RETURNS ON RECORD");
  const postedGen = posted.gen;

  // apply() is blocked, so appliedGen must lag postedGen — the observable gap
  await new Promise((r) => setTimeout(r, 60));
  const mid = await s.readAt("A");
  assert.ok(
    mid.appliedGen < postedGen,
    `no observable gap: appliedGen ${mid.appliedGen} is not < postedGen ${postedGen} — the ack is decoration`,
  );

  release(); // let it settle; appliedGen must catch up
  const deadline = Date.now() + 3000;
  let settled;
  do {
    settled = await s.readAt("A");
    if (settled.appliedGen >= postedGen) break;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() < deadline);
  assert.ok(
    settled.appliedGen >= postedGen,
    "appliedGen never reached postedGen after apply resolved — settle is unobservable",
  );
});

// ---- whenSettled: the surface-side settle primitive (B2 defect 2) -----------
//
// The defect this section pins: a surface's settle() reported {settled:true}
// while state still showed the PREVIOUS item — the state arrived 4,185ms later.
// The surface advanced its local ack at ACCEPTANCE (first line of apply) and
// its hand-rolled settle compared runtime-latest against that premature ack, so
// a caller honoring the settle contract captured/wrote against the WRONG item.
// "Settled" is the harder half (drive.md): application RESOLVED, not accepted,
// not delivered. whenSettled is the ONE seam primitive for it, so a surface
// never hand-rolls this comparison again.

test("THE DOOR TEST — whenSettled refuses the easier halves and resolves only on APPLIED", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const state = { item: null };
  let applyResolved = false;
  const d = driveSurface({
    surface: "s",
    endpoint: `${s.base}/api/drive`,
    intervalMs: 100,
    apply: async (op) => {
      // the 4-second-lag scenario, compressed: application takes real time
      await new Promise((r) => setTimeout(r, 150));
      state.item = op.item;
      applyResolved = true;
    },
  });
  t.after(() => d.stop());
  await new Promise((r) => setTimeout(r, 120)); // baseline

  const posted = await s.drive({ item: 12 });

  // Immediately after POST the op is recorded-but-not-yet-applied: a bounded
  // whenSettled must say so. Anything reporting settled here is returning
  // accepted/delivered under the harder name — the exact defect.
  const early = await d.whenSettled({ timeoutMs: 60 });
  assert.equal(
    early.settled,
    false,
    "whenSettled reported settled while the op was undelivered or in flight — the defect verbatim",
  );
  assert.ok(early.latest >= posted.gen, "the refusal does not name the outstanding generation");

  // The full await: resolves settled:true only once apply() RESOLVED, and the
  // drive + immediate-write sequence lands on the TARGET item.
  const r = await d.whenSettled({ timeoutMs: 4000 });
  assert.equal(r.settled, true, "whenSettled never settled after apply resolved");
  assert.equal(applyResolved, true, "settled:true returned BEFORE apply() resolved");
  assert.equal(state.item, 12, "a write gated on settle would have acted on the previous item");
  assert.equal(r.applied, posted.gen);
});

test("a RECORDED-but-undelivered op is not settled — the posted-not-yet-polled window is seen", async (t) => {
  // The surface's own poll may simply not have fetched the op yet (this client
  // polls every 60s). A settle that only consults local state — or that
  // swallows a failed read as settled:true — reports settled in exactly the
  // window the door test drives through. whenSettled consults the runtime.
  const s = await start();
  t.after(() => s.stop());
  const d = driveSurface({
    surface: "s",
    endpoint: `${s.base}/api/drive`,
    intervalMs: 60_000,
    apply: async () => {},
  });
  t.after(() => d.stop());
  await new Promise((r) => setTimeout(r, 100)); // first poll baselines, then silence

  const posted = await s.drive({ item: 4 });
  const r = await d.whenSettled({ timeoutMs: 300 });
  assert.equal(
    r.settled,
    false,
    "an op recorded at the runtime but never delivered to this surface was reported settled",
  );
  assert.equal(r.latest, posted.gen, "the timeout verdict does not name the latest recorded gen");
  assert.equal(r.applied, 0, "the timeout verdict does not name the applied watermark");
});

test("an op PENDING AT LOAD is baselined, not pending — whenSettled does not wedge on it", async (t) => {
  // resumeLatestOnLoad:false deliberately never applies the op that predates
  // the page. That op must count as the settle FLOOR, not as forever-unsettled:
  // a surface that boots under an old op and waits out every settle timeout is
  // the boot trap the review app papered over with sessionStorage.
  const s = await start();
  t.after(() => s.stop());
  const posted = await s.drive({ play: true }); // recorded BEFORE the surface exists
  const d = driveSurface({
    surface: "s",
    endpoint: `${s.base}/api/drive`,
    intervalMs: 100,
    apply: async () => {
      throw new Error("the baselined op must never be applied");
    },
  });
  t.after(() => d.stop());
  await new Promise((r) => setTimeout(r, 150)); // baseline poll

  const r = await d.whenSettled({ timeoutMs: 400 });
  assert.equal(
    r.settled,
    true,
    `a pre-load op (gen ${posted.gen}) wedged settle — baselined-away is not pending`,
  );
});

test("whenSettled fast path — nothing outstanding settles immediately, applied named", async (t) => {
  const s = await start();
  t.after(() => s.stop());
  let item = null;
  const d = driveSurface({
    surface: "s",
    endpoint: `${s.base}/api/drive`,
    intervalMs: 80,
    apply: async (op) => {
      item = op.item;
    },
  });
  t.after(() => d.stop());
  await new Promise((r) => setTimeout(r, 100)); // baseline

  const posted = await s.drive({ item: 7 });
  const first = await d.whenSettled({ timeoutMs: 4000 });
  assert.equal(first.settled, true);
  assert.equal(item, 7);
  // Already settled: a second call must not wait out a poll cycle to say so.
  const t0 = Date.now();
  const again = await d.whenSettled({ timeoutMs: 4000 });
  assert.equal(again.settled, true);
  assert.equal(again.applied, posted.gen);
  assert.ok(Date.now() - t0 < 1000, "an already-settled client made the caller wait");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
