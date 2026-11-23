// The per-boot key between a Studio and the Node processes it runs (the runtime and every provider).
//
// WHY. The Studio's own port is guarded: by the loopback gate, or by a deployment's server hooks. But the
// runtime and the providers listen on 127.0.0.1 too, each on its own port. A web page the owner visits can
// reach those ports by DNS rebinding, and most providers have no Host or Origin check of their own; a stray
// local tool can reach them as well. Either would go around the Studio's gate. So studio.mjs makes a new
// random key each boot, starts each Node child with this file preloaded (node --import), and adds the key to
// every request it forwards. A child then answers only requests that carry it; anything else gets 403. The
// way in is then the Studio's own port and its gate. (It doesn't separate the accounts on one computer: a
// loopback-only Studio answers every one of them, as one shared workspace does; see contract/server-hooks.md.)
//
// The key reaches a child through its environment, never its arguments (which every user can see in a
// process list), and is removed from process.env here at once, so whatever the child starts doesn't inherit
// it. It's never logged and never in a page: studio.mjs adds it on the way in, and it's stripped from the
// request before the child's own code sees it.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

export const KEY_ENV = "OPENRIG_STUDIO_CHILD_KEY";
export const KEY_HEADER = "x-openrig-studio-key";
// Set in a child only when the key is active, and only from inside the process. A provider may trust
// headers the Studio's admission wrote (an identity header, say) only when this marker is present: every
// request that reached it then came through the Studio.
export const CHILD_MARKER = Symbol.for("openrig.studio.childKey");

const key = process.env[KEY_ENV];
delete process.env[KEY_ENV];

if (key) {
  const want = Buffer.from(key);
  Object.defineProperty(globalThis, CHILD_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  // A request that passed once stays passed: a handler may hand the same request on (a 100-continue
  // handler emitting "request"), and by then its header is gone.
  const passed = new WeakSet();
  // The key leaves every view of the headers the child's code can read: rawHeaders, headers and
  // headersDistinct. Node builds the last two lazily from rawHeaders with the count it parsed, so they are
  // built first, before rawHeaders shrinks under them.
  const strip = (req) => {
    void req.headers;
    void req.headersDistinct;
    const raw = req.rawHeaders;
    for (let i = raw.length - 2; i >= 0; i -= 2)
      if (raw[i].toLowerCase() === KEY_HEADER) raw.splice(i, 2);
    delete req.headers[KEY_HEADER];
    delete req.headersDistinct[KEY_HEADER];
  };
  const carries = (req) => {
    if (passed.has(req)) return true;
    const got = req.headers[KEY_HEADER];
    strip(req);
    if (typeof got !== "string") return false;
    const b = Buffer.from(got);
    const ok = b.length === want.length && timingSafeEqual(b, want);
    if (ok) passed.add(req);
    return ok;
  };
  const LINE = "This part of the Studio only answers the Studio itself.\n";
  // Every server in this process, whoever made it: a request, a 100-continue or expectation check, an
  // upgrade, a CONNECT.
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...a) {
    if (event === "request" || event === "checkContinue" || event === "checkExpectation") {
      const [req, res] = a;
      if (!carries(req)) {
        res.writeHead(403, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(LINE),
        });
        res.end(LINE);
        return true;
      }
    } else if (event === "upgrade" || event === "connect") {
      const [req, socket] = a;
      if (!carries(req)) {
        try {
          socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        } catch {
          socket.destroy();
        }
        return true;
      }
    }
    return emit.call(this, event, ...a);
  };
}
