// Fixed local ttyd endpoints for a loopback-only Studio; the public launcher
// binds only 127.0.0.1. Behind server hooks, tools/hosted-terminals.mjs serves
// the same sockets instead (Origin, expiry and session checks for a Studio
// reached from outside).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { allowedOriginsFrom, isOwnOrigin } from "./server-hooks.mjs";

// Every answer on these routes may be framed only by this Studio's own pages, so another site can't put the
// owner's shell in a frame of its own and trick clicks or keys into it.
export const TERMINAL_FRAMING = Object.freeze({
  "content-security-policy": "frame-ancestors 'self'",
  "x-frame-options": "SAMEORIGIN",
});

const ROUTES = [
  { key: "terminal", path: "/terminal/", env: "STUDIO_TERMINAL_SOCKET" },
  { key: "team", path: "/team/", env: "STUDIO_TEAM_SOCKET" },
];
const PASS = [
  "accept",
  "accept-language",
  "user-agent",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
];
// `shellMissing`: a local Studio that would start its own shell but can't, because ttyd isn't installed. The person's next step
// is then to install ttyd, not to run a listener by hand.
export const NO_TTYD =
  "ttyd isn't installed on this computer. Install it (https://github.com/tsl0922/ttyd), then start the Studio again: a local Studio starts its own shell.";
export function terminalTarget(route, env = process.env, { shellMissing = false } = {}) {
  const file = env[route.env];
  if (!file)
    return {
      path: null,
      state: "not-configured",
      reason:
        shellMissing && route.key === "terminal"
          ? NO_TTYD
          : `Set ${route.env} to the private Unix socket of your ttyd listener.`,
    };
  try {
    if (!path.isAbsolute(file) || path.normalize(file) !== file) throw Error("path");
    const st = fs.lstatSync(file);
    if (!st.isSocket() || st.uid !== process.getuid?.() || st.mode & 0o077) throw Error("socket");
    return { path: route.path, state: "available", target: file };
  } catch {
    return {
      path: null,
      state: "unavailable",
      reason: `The configured ${route.env} socket is unavailable or isn't owned privately by this user.`,
    };
  }
}
// `allowedOrigins`: the same list the loopback gate uses (STUDIO_ALLOWED_ORIGINS), so a page that may change
// the Studio may also open its terminal, and no other.
export function createTerminals(
  env = process.env,
  { shellMissing = false, allowedOrigins = allowedOriginsFrom(env) } = {},
) {
  const active = new Set();
  const match = (pathname) =>
    ROUTES.find((r) => pathname === r.path.slice(0, -1) || pathname.startsWith(r.path));
  const place = () =>
    Object.fromEntries(
      ROUTES.map((r) => {
        const { target, ...state } = terminalTarget(r, env, { shellMissing });
        return [r.key, state];
      }),
    );
  // The loopback gate's Origin rule (tools/server-hooks.mjs): this Studio's own address or an allowed
  // origin. "null", from a sandboxed frame such as a stored artifact, is never either.
  const originOK = (req) => !req.headers.origin || isOwnOrigin(req, allowedOrigins);
  const headers = (req) =>
    Object.fromEntries(
      PASS.filter((k) => typeof req.headers[k] === "string").map((k) => [k, req.headers[k]]),
    );
  function request(req, res) {
    const url = new URL(req.url, "http://localhost"),
      route = match(url.pathname);
    if (!route) return false;
    const reply = (status, reason) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...TERMINAL_FRAMING,
      });
      res.end(JSON.stringify({ state: "unavailable", reason }));
    };
    if (!["GET", "HEAD"].includes(req.method) || url.search) {
      reply(400, "This terminal has a fixed command and takes no browser arguments.");
      return true;
    }
    if (!originOK(req)) {
      reply(403, "Open this terminal from its own Studio.");
      return true;
    }
    const t = terminalTarget(route, env);
    if (!t.target) {
      reply(503, t.reason);
      return true;
    }
    const up = http.request(
      {
        socketPath: t.target,
        path: url.pathname === route.path.slice(0, -1) ? route.path : url.pathname,
        method: req.method,
        headers: headers(req),
      },
      (r) => {
        res.writeHead(r.statusCode || 502, {
          ...r.headers,
          "cache-control": "no-store",
          ...TERMINAL_FRAMING,
        });
        r.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) reply(502, "The terminal did not answer.");
      else res.destroy();
    });
    res.on("close", () => up.destroy());
    up.end();
    return true;
  }
  function upgrade(req, socket, head) {
    const url = new URL(req.url, "http://localhost"),
      route = match(url.pathname);
    if (!route) return false;
    const refuse = (code) => socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
    const t = terminalTarget(route, env);
    if (!originOK(req) || !req.headers.origin || url.search) {
      refuse("403 Forbidden");
      return true;
    }
    if (!t.target || url.pathname !== route.path + "ws") {
      refuse("503 Service Unavailable");
      return true;
    }
    const up = http.request({
      socketPath: t.target,
      path: url.pathname,
      headers: { ...headers(req), connection: "Upgrade", upgrade: "websocket" },
    });
    let peer;
    const timer = setTimeout(() => {
      up.destroy();
      refuse("504 Gateway Timeout");
    }, 10000);
    const end = () => {
      clearTimeout(timer);
      active.delete(socket);
      socket.destroy();
      peer?.destroy();
      up.destroy();
    };
    active.add(socket);
    socket.once("close", end);
    socket.once("error", end);
    up.once("upgrade", (r, remote, initial) => {
      clearTimeout(timer);
      peer = remote;
      if (socket.destroyed) return end();
      socket.write(
        `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n` +
          Object.entries(r.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (initial.length) socket.write(initial);
      if (head.length) peer.write(head);
      peer.once("close", end);
      peer.once("error", end);
      peer.once("end", end);
      socket.once("end", end);
      peer.pipe(socket);
      socket.pipe(peer);
    });
    up.once("response", (r) => {
      r.resume();
      clearTimeout(timer);
      refuse("502 Bad Gateway");
    });
    up.once("error", () => {
      clearTimeout(timer);
      refuse("502 Bad Gateway");
    });
    up.end();
    return true;
  }
  return {
    place,
    request,
    upgrade,
    close: () => {
      for (const socket of active) socket.destroy();
    },
  };
}
