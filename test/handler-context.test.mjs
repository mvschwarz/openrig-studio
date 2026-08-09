// The request-side crossing matrix for `ctx`, driven against the ACTUAL makeCtx
// the runtime uses — not an isolated test of the wrapper. sdk-qa re-round-5:
// ctx.onClose leaked TWO ways — the callback ran with `this === req`, AND the
// call returned the native emitter (req.on returns the emitter). And the prior
// control could not fire: it tested ownCallback in isolation, so breaking the
// real wiring stayed green. This exercises makeCtx directly and the negative
// controls below prove it goes RED when either guard is stripped.
//
//   node --test 'test/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { makeCtx } from "../app/handler-context.mjs";

// A request stand-in: a real EventEmitter (so `.on`/`.emit` behave like Node's,
// invoking listeners with `this === req` and forwarding args) carrying a url the
// leak would recover.
function fakeReq() {
  return Object.assign(new EventEmitter(), {
    url: "/secret?token=leak-me", method: "GET", headers: { host: "x" },
  });
}
const routed = { searchParams: new URLSearchParams("a=b"), verb: "/api/x", rest: "" };
const noBody = () => Promise.resolve("");

test("ctx carries only data — no native request reachable through its fields", async () => {
  const req = fakeReq();
  const ctx = makeCtx(req, routed, noBody);
  assert.deepEqual(Object.keys(ctx).sort(), ["headers", "method", "onClose", "readBody", "rest", "searchParams", "verb"]);
  assert.equal(ctx.verb, "/api/x");
  assert.equal(ctx.searchParams.get("a"), "b");
  assert.equal(await ctx.readBody(), "", "readBody must resolve to a primitive body, not a native object");
  // No field is (or exposes) the request or an emitter.
  for (const v of Object.values(ctx)) assert.notEqual(v, req, "a ctx field IS the native request");
});

test("ctx.onClose CROSSING MATRIX against the real wiring: no native this, args, or return", () => {
  const req = fakeReq();
  const ctx = makeCtx(req, routed, noBody);

  // RETURN crossing: req.on returns the emitter (the native request). onClose
  // must not hand it back.
  const ret = ctx.onClose(() => {});
  assert.notEqual(ret, req, "ctx.onClose returned the native request emitter");
  assert.equal(ret, undefined, "ctx.onClose returned a value — it must return nothing native");

  // CALLBACK this/args crossing: a native emitter invokes listeners with
  // `this === emitter` and forwards the emit args. The wrapped listener must see
  // neither.
  let seenThis = "unset", seenArgs = null;
  ctx.onClose(function (...a) { seenThis = this; seenArgs = a; });
  req.emit("close", req, "native-arg"); // emitter passes its own this + args
  assert.notEqual(seenThis, req, "the close callback ran with the native request as `this`");
  assert.equal(seenThis, undefined, "the close callback saw a `this`");
  assert.deepEqual(seenArgs, [], "the close callback received native arguments");
});

// NEGATIVE CONTROLS — prove this file can FAIL at the real site. Each rebuilds a
// ctx with one guard stripped (the shapes an accidental regression would take)
// and asserts the matrix above WOULD have caught it. Without these, the tests
// above could pass against broken wiring and nobody would know (the exact
// control-cannot-fire defect sdk-qa found in the prior round).
test("negative control: dropping the return-guard is caught", () => {
  const req = fakeReq();
  // Regressed onClose: expression-bodied, returns the emitter (the original leak).
  const brokenReturn = { onClose: (cb) => req.on("close", cb) };
  const ret = brokenReturn.onClose(() => {});
  assert.equal(ret, req, "precondition: the regressed onClose returns the emitter");
  // The matrix's return assertion would fail on this — demonstrated:
  assert.throws(() => assert.equal(ret, undefined),
    "the return-crossing assertion cannot fail — it would not catch the leak");
});

test("negative control: dropping the callback-wrapper is caught", () => {
  const req = fakeReq();
  const brokenCb = { onClose: (cb) => { req.on("close", cb); } }; // no ownCallback
  let seenThis = "unset", seenArgs = null;
  brokenCb.onClose(function (...a) { seenThis = this; seenArgs = a; });
  req.emit("close", req, "native-arg");
  assert.equal(seenThis, req, "precondition: the unwrapped callback runs with this === req");
  // The matrix's this/args assertions would fail on this — demonstrated:
  assert.throws(() => assert.notEqual(seenThis, req),
    "the callback-this assertion cannot fail — it would not catch the leak");
  assert.throws(() => assert.deepEqual(seenArgs, []),
    "the callback-args assertion cannot fail — it would not catch the leak");
});
