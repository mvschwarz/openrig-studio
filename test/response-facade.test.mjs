// The response facade must hand NO native object — the response, or the request
// it back-references — into handler-controlled code in ANY direction. MF1 leaked
// four ways across four rounds: a spelling guard, then `res.req`, then a facade
// property, then facade DELEGATION (`pipeFrom` calling a handler-supplied
// source's `pipe(res)`). This enumerates every method for the one property.
//
//   node --test 'test/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeResFacade } from "../app/response-facade.mjs";

// A fake response that records what it is asked to do and carries a request
// back-reference — the thing a leak recovers.
function fakeRes() {
  const rec = { writes: [], heads: [], headers: [], ended: false };
  const req = { url: "/secret?token=leak-me" };
  const res = {
    req,
    socket: { parser: { incoming: req } },
    writeHead(...a) { rec.heads.push(a); return res; },   // Node returns res (chainable)
    setHeader(...a) { rec.headers.push(a); return res; },
    write(chunk) { rec.writes.push(chunk); return true; },
    end(chunk) { if (chunk !== undefined) rec.writes.push(chunk); rec.ended = true; return res; },
  };
  return { res, req, rec };
}

test("no facade method returns, or otherwise yields, the raw response", () => {
  const { res, rec } = fakeRes();
  const f = makeResFacade(res);

  // Every method returns the facade, a primitive, or undefined — NEVER res.
  assert.equal(f.writeHead(200, {}), f, "writeHead returned something other than the facade");
  assert.notEqual(f.writeHead(200, {}), res, "writeHead returned the raw response");
  assert.equal(f.setHeader("a", "b"), f, "setHeader did not return the facade");
  assert.notEqual(f.setHeader("a", "b"), res, "setHeader returned the raw response");
  assert.equal(typeof f.write("x"), "boolean", "write returned a non-primitive");
  assert.notEqual(f.write("x"), res, "write returned the raw response");
  assert.equal(f.end(), undefined, "end returned something (Node's end returns res — must be swallowed)");

  // The facade exposes only the sanctioned methods — no res, req, socket.
  assert.deepEqual(Object.keys(f).sort(), ["end", "pipeFrom", "setHeader", "write", "writeHead"]);
  for (const k of ["req", "res", "socket", "connection"]) {
    assert.ok(!(k in f), `the facade exposes '${k}' — a path to the request`);
  }
  // writeHead/write/end still drive the real response.
  f.write("chunk"); f.end("last");
  assert.ok(rec.writes.includes("chunk") && rec.writes.includes("last") && rec.ended);
});

test("methods do not use `this`, so rebinding one cannot smuggle the response", () => {
  const { res } = fakeRes();
  const f = makeResFacade(res);
  // Call a method with a hostile `this`; it must behave identically and expose
  // nothing (the methods close over res, they do not read `this`).
  const evil = {};
  assert.equal(f.write.call(evil, "x"), true, "write depended on `this`");
  assert.equal(f.writeHead.call(evil, 200, {}), f, "writeHead depended on `this`");
  assert.ok(!("req" in evil) && !("res" in evil), "a method wrote the response onto its `this`");
});

test("pipeFrom PULLS from the source and hands it nothing — the delegation leak is closed", async () => {
  // sdk-qa's re-round-3 instrument: a source whose `pipe` is invoked with the raw
  // response. After the inversion the facade iterates the source and writes to
  // res itself; the source's `pipe` is never called and its iterator receives no
  // argument, so the response never crosses to handler-controlled code.
  const { res, rec } = fakeRes();
  const f = makeResFacade(res);

  const captured = { pipeArg: "unset", nextArg: "unset", iterated: false };
  const trojan = {
    pipe(r) { captured.pipeArg = r; },                       // the exact leak shape
    [Symbol.asyncIterator]() {
      captured.iterated = true;
      let done = false;
      return { next: async (x) => { captured.nextArg = x; if (done) return { done: true }; done = true; return { value: "chunk", done: false }; } };
    },
  };
  await f.pipeFrom(trojan);

  assert.equal(captured.pipeArg, "unset", "pipeFrom called the source's pipe() — it hands the response out");
  assert.equal(captured.nextArg, undefined, "the source's iterator was handed an argument (must receive nothing)");
  assert.ok(captured.iterated, "pipeFrom did not iterate the source");
  assert.ok(rec.writes.includes("chunk"), "pipeFrom did not write the pulled chunk to the response");
  assert.ok(rec.ended, "pipeFrom did not end the response");
});

test("pipeFrom ends the response even when the source throws mid-stream", async () => {
  const { res, rec } = fakeRes();
  const f = makeResFacade(res);
  const boom = { [Symbol.asyncIterator]() { return { next: async () => { throw new Error("mid-stream"); } }; } };
  await f.pipeFrom(boom); // must not reject
  assert.ok(rec.ended, "a mid-stream failure left the response open");
});
