// The Desktop: the box's own desktop (VNC behind websockify on this machine), reached through the Studio at /desktop/ws.
//
// websockify listens on loopback, and the Studio's admission (server hooks, contract/server-hooks.md) is the only way in
// from outside: the upgrade has passed admission before anything here runs. Without an admission hook, studio.mjs never
// reads the target, so a loopback-only local Studio offers no Desktop. This adds what a WebSocket needs on top of admission:
//   - the Origin must be one of the box's own addresses (SIGNIN_ORIGINS, comma-separated), so another site can't open the
//     desktop with the person's cookie;
//   - one fixed target the client can't choose (no host, port, path or query from the request), either
//       STUDIO_DESKTOP_SOCKET=/abs/path: websockify on a Unix socket owned by the user this Studio runs as, mode 0600.
//         Preferred: no other local user can reach it. At each upgrade the socket must be a socket, owned by this
//         process's user, with no group or other access, or the upgrade is refused ("not ready") and
//         /api/studio/place says desktop: null; or
//       STUDIO_DESKTOP_WS=ws://127.0.0.1:<port>[/path]: websockify on loopback TCP, the fallback (any local user can
//         reach a loopback port, so prefer the socket);
//   - only the WebSocket handshake headers go on: no cookie and no sign-in token reach websockify;
//   - the socket is closed when the sign-in expires (the principal's exp), so a desktop open in a tab never outlives it:
//     a WebSocket close frame, code 4001 "sign-in expired", so the page can say "Sign in again" rather than
//     "disconnected". It is sent between two of the desktop's frames, never inside one (see frameTracker); if no
//     boundary comes within 2 s, the socket is simply closed. A reconnect is a new upgrade, admitted and checked again;
//   - when the principal carries `sessions`, the tunnel registers with it and closes when the person's session ends.
// Unset or invalid: no route, and the boot line says why; GET /api/studio/place says desktop: null, so the Desktop app
// shows "Not set up".
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export const DESKTOP_PATH = "/desktop/ws";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HANDSHAKE = [
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];
const MAX_TIMER = 2 ** 31 - 1;
// websockify answers a local upgrade in milliseconds; 10 s without a 101 means it isn't going to.
const HANDSHAKE_MS = 10000;
// Aborting websockify's side: a reset, not a FIN, so an upstream that allows half-open connections can't keep its end open.
const abort = (s) => {
  try {
    s?.resetAndDestroy ? s.resetAndDestroy() : s?.destroy();
  } catch {
    s?.destroy();
  }
};
export const EXPIRED_CODE = 4001,
  EXPIRED_REASON = "sign-in expired";
// A server-to-client close frame: FIN + opcode 8, unmasked, payload = the code (2 bytes) and the reason.
const closeFrame = (code, reason) => {
  const r = Buffer.from(reason);
  return Buffer.concat([Buffer.from([0x88, 2 + r.length, code >> 8, code & 0xff]), r]);
};

// Where the desktop's frames begin and end in the byte stream websockify sends, so a close frame can go in between two of them.
// It reads only frame headers (RFC 6455 5.2: two bytes, an extended length of 0, 2 or 8 bytes, a mask key if masked) and counts
// payload bytes; it never decodes, buffers or alters a payload. onFrame(firstByte), when given, hears each frame's first header
// byte (FIN and opcode) as its header completes.
export function frameTracker(onFrame) {
  let hdr = Buffer.alloc(0),
    left = 0;
  const atBoundary = () => left === 0 && hdr.length === 0;
  const headerLength = (h) =>
    h.length < 2 ? 2 : 2 + ({ 126: 2, 127: 8 }[h[1] & 0x7f] ?? 0) + (h[1] & 0x80 ? 4 : 0);
  const payloadLength = (h) => {
    const l = h[1] & 0x7f;
    return l === 126 ? h.readUInt16BE(2) : l === 127 ? Number(h.readBigUInt64BE(2)) : l;
  };
  // Consumes buf. With stop, returns the offset of the first frame boundary in it (0..length), else -1 (and consumes it all).
  function consume(buf, stop = false) {
    let i = 0;
    for (;;) {
      if (stop && atBoundary()) return i;
      if (i >= buf.length) return -1;
      if (left > 0) {
        const n = Math.min(left, buf.length - i);
        left -= n;
        i += n;
        continue;
      }
      hdr = Buffer.concat([hdr, buf.subarray(i, i + 1)]);
      i++;
      if (hdr.length < headerLength(hdr)) continue;
      onFrame?.(hdr[0]);
      left = payloadLength(hdr);
      hdr = Buffer.alloc(0);
    }
  }
  return { consume, atBoundary };
}

export function readDesktopTarget(env = process.env) {
  const sock = env.STUDIO_DESKTOP_SOCKET,
    raw = env.STUDIO_DESKTOP_WS;
  const has = (v) => v !== undefined && v !== "";
  if (has(sock) && has(raw))
    return {
      target: null,
      describe: "desktop off: set STUDIO_DESKTOP_SOCKET or STUDIO_DESKTOP_WS, not both",
    };
  if (has(sock)) {
    const offS = (why) => ({ target: null, describe: `desktop off: STUDIO_DESKTOP_SOCKET ${why}` });
    if (!path.isAbsolute(sock) || path.normalize(sock) !== sock || sock.endsWith("/"))
      return offS("must be an absolute, normalised path");
    if (Buffer.byteLength(sock) > 100) return offS("is too long for a Unix socket path");
    return {
      target: { socketPath: sock, path: "/" },
      describe: `desktop : ${DESKTOP_PATH} -> the Unix socket ${sock}, behind admission, closed at the sign-in's expiry`,
    };
  }
  if (!has(raw)) return { target: null, describe: null };
  const off = (why) => ({ target: null, describe: `desktop off: STUDIO_DESKTOP_WS ${why}` });
  let u;
  try {
    u = new URL(raw);
  } catch {
    return off("isn't a URL");
  }
  if (u.protocol !== "ws:") return off("must be ws:// (the hop is loopback)");
  if (!LOOPBACK.has(u.hostname))
    return off("must name a loopback host (127.0.0.1, localhost or [::1])");
  if (!u.port) return off("needs a port");
  if (u.username || u.password) return off("must not carry credentials");
  if (u.search || u.hash) return off("must not carry a query or fragment");
  const target = {
    host: u.hostname === "[::1]" ? "::1" : u.hostname,
    port: Number(u.port),
    path: u.pathname || "/",
  };
  return {
    target,
    describe: `desktop : ${DESKTOP_PATH} -> loopback port ${target.port}, behind admission, closed at the sign-in's expiry`,
  };
}

// Ready now: a TCP target always (an upgrade finds out by connecting, and place asks desktopAnswering below); a socket only
// while it is a socket, ours, mode 0600 or tighter. Checked per request, because a service manager may create or replace it
// after this Studio started.
export function desktopReady(target) {
  if (!target) return false;
  if (!target.socketPath) return true;
  try {
    const st = fs.lstatSync(target.socketPath);
    return (
      st.isSocket() &&
      (typeof process.getuid !== "function" || st.uid === process.getuid()) &&
      (st.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

// Whether the Desktop is answering, for /api/studio/place to advertise it. A socket target: desktopReady. A TCP target:
// something accepts a connection on its loopback port now, found by one connect of at most `timeoutMs`. Its answer is
// kept `ttlMs`, and callers asking while a connect is in flight share it, so a page reading place every few seconds opens
// at most one connection per `ttlMs`. A plain connect, not a WebSocket handshake: it tells a port nothing listens on from
// one something does, which is what place needs to stop advertising a Desktop that isn't there.
const answers = new WeakMap();
export function desktopAnswering(
  target,
  { ttlMs = 2000, timeoutMs = 300, now = Date.now, connect = net.connect } = {},
) {
  if (!target) return Promise.resolve(false);
  if (target.socketPath) return Promise.resolve(desktopReady(target));
  const known = answers.get(target);
  if (known?.pending) return known.pending;
  if (known && now() - known.at < ttlMs) return Promise.resolve(known.ok);
  const entry = { at: 0, ok: false, pending: null };
  answers.set(target, entry);
  let settled = false;
  const pending = new Promise((resolve) => {
    let timer = null,
      s = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s?.destroy();
      Object.assign(entry, { at: now(), ok, pending: null });
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    try {
      s = connect({ host: target.host, port: target.port });
      s.once("connect", () => finish(true));
      s.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
  // A connect that failed at once has already settled: nothing is in flight to share.
  if (!settled) entry.pending = pending;
  return pending;
}

export const originsFrom = (env = process.env) =>
  new Set(
    String(env.SIGNIN_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

// What a session's onClose gave, made safe for a close frame and a header line: a code in the application range (4000-4999)
// and a short printable reason.
const sessionEnd = (why) => ({
  code: Number.isInteger(why?.code) && why.code >= 4000 && why.code <= 4999 ? why.code : 4000,
  reason:
    String(why?.reason ?? "")
      .replace(/[^\x20-\x7e]/g, "")
      .slice(0, 120) || "session ended",
});

const refuseWith = (header) => (socket, status, why) => {
  try {
    socket.end(
      `HTTP/1.1 ${status}\r\nconnection: close\r\n${header}: ${why}\r\ncontent-length: 0\r\n\r\n`,
    );
  } catch {
    socket.destroy();
  }
};

// req has passed admission; exp is the admitted sign-in's expiry (seconds). Optional sessions/session bind the tunnel to the
// person's current session.
export const upgradeDesktop = (req, socket, head, o) =>
  tunnelWebSocket(req, socket, head, { ...o, header: "x-openrig-desktop", what: "the desktop" });

// The tunnel itself, shared with other loopback WebSocket services: Origin, readiness, one deadline at exp, handshake headers
// only, the close frame between two frames. header and what name the service in refusals; onOpen() runs once when the 101
// reaches the browser, onClose(reason) once when it ends: "sign-in expired", a session's own reason, "closed by the browser"
// (its close frame, or its side going away first) or "<what> ended" (the upstream hung up with no close from the browser);
// onRefuse(why) once for an upgrade refused here, before any open. sessions.register(session, onClose) is called once per
// upgrade; onClose({ code, reason }) ends the tunnel (a 403 with that reason before the 101, a close frame with that code
// after it), and the unregister it returns runs when the browser's socket closes.
export function tunnelWebSocket(
  req,
  socket,
  head,
  {
    target,
    origins,
    exp,
    now = Date.now,
    header,
    what,
    onOpen,
    onClose,
    onRefuse,
    sessions,
    session,
  },
) {
  const refuseOnce = refuseWith(header);
  let refused = false;
  const refuse = (sock, status, why) => {
    if (!refused) {
      refused = true;
      onRefuse?.(why);
    }
    refuseOnce(sock, status, why);
  };
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origins.has(origin))
    return refuse(socket, "403 Forbidden", "not this box's Studio");
  // A principal without an expiry can't be bounded, so it gets no tunnel.
  if (typeof exp !== "number" || !Number.isFinite(exp))
    return refuse(socket, "403 Forbidden", "no sign-in expiry");
  // ONE absolute deadline, the sign-in's exp, for the whole life of this request: the handshake with websockify as well as the
  // open tunnel, so a 101 that arrives late doesn't get the full duration again, and a handshake that never comes back doesn't
  // hold both sides open past exp.
  const deadline = exp * 1000;
  const left = () => deadline - now();
  if (!(left() > 0)) return refuse(socket, "403 Forbidden", "sign-in expired");
  if (!desktopReady(target)) return refuse(socket, "503 Service Unavailable", "not ready");
  const headers = {
    host: target.socketPath
      ? "localhost"
      : `${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}`,
    upgrade: "websocket",
    connection: "Upgrade",
  };
  for (const k of HANDSHAKE) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
  const up = http.request(
    target.socketPath
      ? { socketPath: target.socketPath, path: target.path, method: "GET", headers }
      : { host: target.host, port: target.port, path: target.path, method: "GET", headers },
  );
  // Before the 101: the handshake ends at exp (a 403, the same as an expired sign-in at admission) or after HANDSHAKE_MS
  // (a 504), whichever is first.
  let upgraded = false,
    sessionReason = null,
    unregister = () => {};
  // Which of the two deadlines this timer is, decided when it is set: a timer can fire a millisecond before the wall clock
  // reaches exp, and re-reading the clock then would say "time left" and answer 504 instead of 403. One reading of the clock
  // decides both the kind and the delay, since two readings could disagree.
  const remaining = left(),
    atExpiry = remaining <= HANDSHAKE_MS;
  const pending = setTimeout(
    () => {
      if (upgraded) return;
      abort(up.socket);
      up.destroy();
      if (atExpiry) refuse(socket, "403 Forbidden", "sign-in expired");
      else refuse(socket, "504 Gateway Timeout", `${what} didn't answer`);
    },
    Math.max(0, Math.min(remaining, HANDSHAKE_MS)),
  );
  let endSession = (why) => {
    sessionReason = why;
    clearTimeout(pending);
    abort(up.socket);
    up.destroy();
    refuse(socket, "403 Forbidden", why.reason);
  };
  up.on("upgrade", (upRes, upSocket, upHead) => {
    upgraded = true;
    clearTimeout(pending);
    if (sessionReason || !(left() > 0) || socket.destroyed) {
      abort(upSocket);
      return refuse(socket, "403 Forbidden", "sign-in expired");
    }
    socket.write(
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n` +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    const frames = frameTracker();
    let closing = false,
      sent = false,
      done = false,
      grace = null,
      reason = null,
      browserClosed = false;
    let closeCode = EXPIRED_CODE,
      closeReason = EXPIRED_REASON;
    // The browser's own close frame (opcode 8), read from its side of the stream: after it, the upstream may well hang up
    // before the browser's TCP end arrives, and that is still the browser's close.
    const fromBrowser = frameTracker((b0) => {
      if ((b0 & 0x0f) === 0x8) browserClosed = true;
    });
    onOpen?.();
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      socket.destroy();
      upSocket.destroy();
      onClose?.(reason ?? (browserClosed ? "closed by the browser" : why));
    };
    // The close frame, then a half-close: the browser answers with its own close and hangs up, which ends this side ("end" below).
    const sendClose = () => {
      if (sent) return;
      sent = true;
      reason = closeReason;
      clearTimeout(grace);
      socket.write(closeFrame(closeCode, closeReason));
      socket.end();
      upSocket.destroy();
      grace = setTimeout(() => finish(), 2000);
    };
    const toBrowser = (d) => {
      if (done || sent) return;
      if (!closing) {
        frames.consume(d);
        if (!socket.write(d)) upSocket.pause();
        return;
      }
      const i = frames.consume(d, true);
      if (i < 0) {
        socket.write(d);
        return;
      }
      if (i > 0) socket.write(d.subarray(0, i));
      sendClose();
    };
    // Wait for a frame boundary before the close frame, but no longer than 2 s.
    const beginClose = (code, why) => {
      if (closing || done) return;
      closing = true;
      closeCode = code;
      closeReason = why;
      reason = why;
      if (frames.atBoundary()) sendClose();
      else grace = setTimeout(() => finish(), 2000);
    };
    endSession = (why) => {
      sessionReason = why;
      beginClose(why.code, why.reason);
    };
    const timer = setTimeout(
      () => beginClose(EXPIRED_CODE, EXPIRED_REASON),
      Math.min(Math.max(0, left()), MAX_TIMER),
    );
    if (upHead?.length) toBrowser(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.on("data", toBrowser);
    socket.on("data", (d) => {
      fromBrowser.consume(d);
      if (!closing && !upSocket.write(d)) socket.pause();
    });
    socket.on("drain", () => upSocket.resume());
    upSocket.on("drain", () => socket.resume());
    // Either side going away ends both (an HTTP server's sockets allow half-open, so "end" alone would leave the other side
    // open), except websockify's side once the close frame is out: that one this process ended itself.
    for (const ev of ["error", "end", "close"]) {
      socket.on(ev, () => finish("closed by the browser"));
      upSocket.on(ev, () => {
        if (!sent) finish(`${what} ended`);
      });
    }
  });
  up.on("response", (r) => {
    clearTimeout(pending);
    r.resume();
    refuse(socket, "502 Bad Gateway", `${what} didn't answer`);
  });
  up.on("error", () => {
    if (upgraded) return;
    clearTimeout(pending);
    if (!socket.destroyed && socket.writable)
      refuse(socket, "502 Bad Gateway", `${what} isn't running`);
  });
  socket.on("error", () => {
    clearTimeout(pending);
    up.destroy();
  });
  socket.on("close", () => {
    unregister();
    if (!upgraded) {
      clearTimeout(pending);
      abort(up.socket);
      up.destroy();
    }
  });
  if (sessions) {
    const u = sessions.register(session, (why) => endSession(sessionEnd(why)));
    if (typeof u === "function") unregister = u;
  }
  if (!sessionReason) up.end();
}
