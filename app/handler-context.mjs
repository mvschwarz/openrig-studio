import { ownCallback } from "./response-facade.mjs";

// The `ctx` a route handler receives — the request SIDE of the same rule the
// response facade enforces: no native object (the request, its socket, an
// emitter) crosses into handler-controlled code in any direction. The request
// itself never reaches a handler; `ctx` carries only what a handler needs.
//
// The crossings that had to be closed here, matching the response side:
//   - `method`/`headers`/`searchParams`/`verb`/`rest` are plain data.
//   - `readBody()` resolves to a string — a primitive, no native object.
//   - `onClose(cb)` registers a close listener, and closing it needed BOTH:
//       * the callback is wrapped with `ownCallback`, because
//         `req.on("close", cb)` invokes `cb` with `this === req`; and
//       * the call returns UNDEFINED, because `EventEmitter.on` returns the
//         emitter — the native request — which an expression-bodied arrow handed
//         straight back to the handler as the return value (RETURN crossing).
//
// `readBody` is injected rather than imported so this module has no side effects
// and is unit-testable against a fake request.
export function makeCtx(req, routed, readBody) {
  return {
    method: req.method,
    headers: req.headers,
    searchParams: routed.searchParams,
    verb: routed.verb,
    rest: routed.rest,
    readBody: () => readBody(req),
    onClose(cb) {
      req.on("close", ownCallback(cb));
      // Return nothing: `req.on` returns the native emitter, which must not cross
      // back to the handler.
      return undefined;
    },
  };
}
