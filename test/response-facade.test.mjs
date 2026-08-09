// The response facade must hand NO native object — the response, or the request
// it back-references — into handler-controlled code in ANY direction. MF1 leaked
// four ways across four rounds: a spelling guard, then `res.req`, then a facade
// property, then facade DELEGATION (`pipeFrom` calling a handler-supplied
// source's `pipe(res)`). This enumerates every method for the one property.
//
//   node --test 'test/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeResFacade, ownCallback } from "../app/response-facade.mjs";

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

test("CROSSING MATRIX: a handler CALLBACK passed to any method is invoked by the facade, not the native response", async () => {
  // sdk-qa re-round-4: Node invokes `res.end(chunk, cb)` (and `write`) with the
  // native response as the callback's `this`, from which a handler recovers the
  // request. This must be measured against a REAL ServerResponse, not a fake —
  // the fake never invokes the callback with res as this. Every native method
  // that takes a callback is exercised; the callback must see no native `this`
  // and no native argument.
  const seen = [];
  const server = http.createServer((req, res) => {
    const f = makeResFacade(res);
    const record = (label) => function (...args) {
      seen.push({ label, thisIsRes: this === res, thisReqUrl: (() => { try { return this && this.req && this.req.url; } catch { return "throw"; } })(), args });
    };
    f.write("chunk", record("write"));
    f.end("body", record("end"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await fetch(`http://127.0.0.1:${port}/secret?token=leak-me`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
  } finally { server.close(); }

  assert.ok(seen.length >= 1, "no facade callback fired — the matrix measured nothing");
  for (const c of seen) {
    assert.equal(c.thisIsRes, false, `${c.label} callback ran with the native response as \`this\` — the request is recoverable`);
    assert.ok(!c.thisReqUrl || c.thisReqUrl === "throw", `${c.label} callback recovered the request url through \`this\``);
    assert.deepEqual(c.args, [], `${c.label} callback received native arguments — a native object can cross as a callback arg`);
  }
});

test("ownCallback severs `this` and arguments — the request-side (onClose) uses the same wrapper", () => {
  // ctx.onClose wraps a handler close callback with ownCallback, because
  // `req.on("close", cb)` invokes cb with `this === req`. The wrapper is a
  // facade-owned arrow: no `this` a handler can use, and no forwarded argument.
  let capturedThis = "unset";
  const capturedArgs = [];
  const wrapped = ownCallback(function (...args) { capturedThis = this; capturedArgs.push(...args); });
  // Invoke the wrapper the way a native emitter would: with a native `this` and
  // native arguments. Both must be discarded.
  const fakeNative = { req: { url: "/secret" } };
  wrapped.call(fakeNative, fakeNative, "extra");
  assert.notEqual(capturedThis, fakeNative, "ownCallback let the native `this` through");
  assert.equal(capturedThis, undefined, "the handler callback saw a `this` — it must be called plainly");
  assert.deepEqual(capturedArgs, [], "ownCallback forwarded native arguments to the handler callback");
});
