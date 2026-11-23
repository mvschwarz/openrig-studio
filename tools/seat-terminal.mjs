// The seat terminals at /chat: one ttyd that attaches a browser to a real agent seat (tools/seat-attach.sh), served
// through this Studio's own origin.
//
// ttyd listens on a Unix socket in a fresh 0700 folder this Studio owns, never on a TCP port. ttyd isn't one of the
// Studio's Node children, so the child key (tools/child-key.mjs) can't guard it: on a loopback port, a page the owner
// visits (DNS rebinding) or a stray local tool could open /chat's WebSocket directly, around the Studio's gate, and type
// into a seat. A socket in the Studio's own 0700 folder can only be opened by the Studio's user, so the way in is the
// Studio's port and its gate; the tunnel checks it is a socket owned by this user with no group or other access before
// every connection. (The Studio's port itself is open to every account on this computer: see contract/server-hooks.md,
// "Who a local Studio trusts".)
//
// Every /chat answer may be framed only by this same origin (CHAT_FRAMING). The WebSocket:
//   - with a principal that carries `exp` or `sessions` (a Studio behind server hooks): tools/desktop.mjs's tunnel, so
//     the socket closes at the sign-in's exp and when the person's session ends, the Origin must be one of the box's
//     own (SIGNIN_ORIGINS), and only the WebSocket handshake headers reach ttyd. A principal with `sessions` but no `exp`
//     is refused, as for the Desktop: a tunnel that can't be bounded isn't opened;
//   - otherwise (the loopback default): a plain tunnel, once the Origin is this Studio's own address (the Host the
//     request was admitted on) or one of the allowed origins (STUDIO_ALLOWED_ORIGINS on a loopback-only Studio,
//     SIGNIN_ORIGINS behind hooks), so another site can't open a seat from the owner's browser.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { desktopReady, tunnelWebSocket } from "./desktop.mjs";

export const CHAT_FRAMING = Object.freeze({ "content-security-policy": "frame-ancestors 'self'" });
export const isChatPath = (pathname) => pathname === "/chat" || pathname.startsWith("/chat/");
const SOCKET_NAME = "t.sock";

// A fresh 0700 folder for ttyd's socket (mkdtemp makes it 0700), or null with the reason. A Unix socket path is at most
// ~100 bytes, so a temp folder whose path is longer than that gets no seat terminals rather than a socket elsewhere.
export function createSeatSocket({ tmpdir = os.tmpdir(), uid = process.getuid?.() } = {}) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(tmpdir, "openrig-seat-"));
  } catch (e) {
    return {
      socket: null,
      reason: `couldn't make a private folder for it (${e.code || e.message})`,
    };
  }
  const socket = path.join(dir, SOCKET_NAME);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { socket: null, reason: "its folder isn't private to this user" };
  }
  if (Buffer.byteLength(socket) > 100) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { socket: null, reason: "the temp folder's path is too long for a Unix socket" };
  }
  // ttyd sets its socket to 0660 itself, ignoring the umask, sometimes just after creating it. Tighten this folder's
  // socket to 0600 whenever the folder changes, and again before every connection (tighten() below).
  const tighten = () => {
    try {
      const s = fs.lstatSync(socket);
      if (s.isSocket() && (uid === undefined || s.uid === uid) && (s.mode & 0o777) !== 0o600)
        fs.chmodSync(socket, 0o600);
    } catch {
      /* Not there yet (ttyd starting or restarting): the next change or connection tightens it. */
    }
  };
  let watcher = null;
  try {
    watcher = fs.watch(dir, tighten);
    watcher.on("error", () => {});
    watcher.unref?.();
  } catch {
    /* No watcher on this platform: tighten() before each connection still holds. */
  }
  tighten();
  return {
    socket,
    dir,
    tighten,
    close() {
      try {
        watcher?.close();
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

const frameOnly = (headers) => ({ ...headers, ...CHAT_FRAMING });

// The terminal page and its assets, from ttyd's socket. `shim`, when given, is spliced in right after <head> (the
// clipboard shim): the page is asked for uncompressed so it can be.
export function proxyChatPage(req, res, { socketPath, shim = "" }) {
  const headers = { ...req.headers, "accept-encoding": "identity" };
  const up = http.request({ socketPath, path: req.url, method: req.method, headers }, (r) => {
    const isHtml = String(r.headers["content-type"] || "").includes("text/html");
    if (!isHtml || !shim) {
      res.writeHead(r.statusCode || 502, frameOnly(r.headers));
      return r.pipe(res);
    }
    const chunks = [];
    r.on("data", (c) => chunks.push(c));
    r.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8");
      const i = html.indexOf("<head>");
      // No <head> means this is not the page we thought: pass it through untouched rather than corrupt it.
      if (i > -1) html = html.slice(0, i + 6) + shim + html.slice(i + 6);
      const h = frameOnly(r.headers);
      delete h["content-length"];
      delete h["content-encoding"];
      delete h["transfer-encoding"];
      h["content-length"] = Buffer.byteLength(html);
      res.writeHead(r.statusCode || 200, h);
      res.end(html);
    });
  });
  up.on("error", () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, frameOnly({ "content-type": "application/json" }));
    res.end('{"ok":false,"error":"terminal unavailable"}');
  });
  req.pipe(up);
}

const refuse = (socket, status, why) => {
  try {
    socket.end(
      `HTTP/1.1 ${status}\r\nconnection: close\r\nx-openrig-chat: ${why}\r\ncontent-length: 0\r\n\r\n`,
    );
  } catch {
    socket.destroy();
  }
};

// The loopback default's Origin rule: this Studio's own address (the Host the request was admitted on, over http or
// https) or one of the box's configured origins. A browser always sends an Origin on a WebSocket; "null" (a sandboxed
// frame, a stored artifact) is never this Studio.
export function sameStudioOrigin(req, origins) {
  const o = req.headers.origin,
    h = req.headers.host;
  if (typeof o !== "string" || !o || o === "null") return false;
  if (origins.has(o)) return true;
  return typeof h === "string" && !!h && (o === `http://${h}` || o === `https://${h}`);
}

// One /chat WebSocket, already admitted as `principal`. Returns nothing; the socket is answered or tunnelled.
export function upgradeChat(req, socket, head, { socketPath, principal, origins, log = () => {} }) {
  if (principal && (principal.exp != null || principal.sessions))
    return tunnelWebSocket(req, socket, head, {
      target: { socketPath, path: req.url },
      origins,
      exp: principal.exp,
      sessions: principal.sessions,
      session: principal.session,
      header: "x-openrig-chat",
      what: "the chat terminal",
      onClose: (why) => log(`chat: closed at ${new Date().toISOString()} (${why})`),
      onRefuse: (why) =>
        log(
          `chat: refused at ${new Date().toISOString()} (${why === "not this box's Studio" ? "origin" : why})`,
        ),
    });
  if (!sameStudioOrigin(req, origins)) return refuse(socket, "403 Forbidden", "not this Studio");
  if (!desktopReady({ socketPath })) return refuse(socket, "503 Service Unavailable", "not ready");
  const up = http.request({ socketPath, path: req.url, method: req.method, headers: req.headers });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n` +
        Object.entries(upRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (upHead?.length) socket.write(upHead);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
    upSocket.on("close", () => socket.destroy());
    socket.on("close", () => upSocket.destroy());
  });
  up.on("response", (r) => {
    r.resume();
    refuse(socket, "502 Bad Gateway", "the chat terminal didn't answer");
  });
  up.on("error", () => refuse(socket, "502 Bad Gateway", "the chat terminal isn't running"));
  if (head?.length) up.write(head);
  up.end();
}
