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
// So every method here passes only the HANDLER'S OWN arguments into `res`,
// returns only the facade / a primitive / undefined (never `res`), and does not
// use `this` (so rebinding a method changes nothing). The one method that used
// to hand `res` out was `pipeFrom`: it called a handler-supplied source's
// `pipe(res)`, delivering the raw response straight to handler-controlled code.
// It is INVERTED — the facade PULLS chunks from the source and writes them to
// `res` itself, handing the source nothing.
export function makeResFacade(res) {
  const facade = {
    writeHead(...args) { res.writeHead(...args); return facade; },
    setHeader(...args) { res.setHeader(...args); return facade; },
    write(...args) { return res.write(...args); },
    end(...args) { res.end(...args); },
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
