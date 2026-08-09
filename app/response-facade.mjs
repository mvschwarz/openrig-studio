// The response a route handler is given — and the whole point is what it does
// NOT give.
//
// A handler must not be able to recover the request. Node's `ServerResponse`
// back-references it (`res.req`, and via the socket), so handing handlers the
// raw `res` leaked the url. The property is stronger than "hide `res.req`": NO
// facade-held native object (the response OR, through it, the request) may cross
// into handler-controlled code in ANY direction —
//   - as an argument to a handler-supplied function,
//   - as the `this` of one,
//   - as a return value,
//   - as a callback parameter,
//   - or as an event payload.
//
// The rule is not "forward only handler-owned arguments" — that was too narrow.
// It is: THE FACADE OWNS EVERY INVOCATION AND EVERY REFERENCE. A handler
// argument that is a CALLBACK is not handed to `res` to invoke, because Node
// invokes such a callback with the native response as its `this` (measured:
// `res.end(chunk, cb)` runs `cb` with `this === res`, from which `this.req.url`
// recovers the request). So any handler-supplied function is replaced with a
// facade-owned wrapper that the facade controls: called with no `this` a handler
// can use (a lexical arrow, never `res`) and no arguments (native `this`/args
// discarded). The handler is still notified; it just receives nothing native.
//
// `ownCallback` is exported because the request side has the same shape:
// `req.on("close", cb)` would invoke a handler's close callback with `this ===
// req`, so the adapter wraps that callback with this too.
export const ownCallback = (fn) => () => fn();

// Replace every function in an argument list with a facade-owned wrapper; pass
// non-function arguments through unchanged.
const own = (args) => args.map((a) => (typeof a === "function" ? ownCallback(a) : a));

export function makeResFacade(res) {
  const facade = {
    writeHead(...args) { res.writeHead(...own(args)); return facade; },
    setHeader(...args) { res.setHeader(...own(args)); return facade; },
    write(...args) { return res.write(...own(args)); },
    end(...args) { res.end(...own(args)); },
    // Stream a handler-supplied source to the client WITHOUT handing the source
    // the response. The facade iterates the source (which yields chunks TO the
    // facade) and writes each chunk to `res` — `res` never crosses to the
    // source. A mid-stream failure ends the truncated response rather than
    // rethrowing past a 200 that may already be sent.
    async pipeFrom(source) {
      try {
        for await (const chunk of source) res.write(chunk);
      } catch {
        /* mid-stream failure — fall through to end the truncated response */
      } finally {
        res.end();
      }
    },
  };
  return facade;
}
