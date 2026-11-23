// The box's children (providers, the runtime, the seat terminal): started, watched, restarted.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// Replaces a fire-and-forget spawn that logged an exit only when its code was non-zero. A child killed by a signal exits
// with code null, so its death was silent, and nothing restarted it: the box kept proxying to a dead port and the route
// answered 502 until the next reload. Now:
//   - every exit is logged with its code AND signal;
//   - a child that exits while the box is running is restarted on the same command and port, after a backoff
//     (1 s, 2 s, 4 s … 30 s);
//   - more than `maxRestarts` exits inside `windowMs` means it can't stay up: the box stops everything and exits non-zero,
//     so whatever supervises the box (launchd KeepAlive) restarts it whole, rather than serving half a studio;
//   - health() reports each child: up, pid, port, restarts in the window, last exit;
//   - remove(label) retires one child for good (a provider an extension replaced): its queued restart is cancelled.
import { spawn } from "node:child_process";
import net from "node:net";

export const backoff = (n) => Math.min(1000 * 2 ** Math.max(0, n - 1), 30000);

export function createSupervisor({
  spawnFn = spawn,
  log = (m) => console.error(m),
  now = () => Date.now(),
  schedule = setTimeout,
  onGiveUp = () => process.exit(1),
  maxRestarts = 5,
  windowMs = 5 * 60000,
} = {}) {
  const kids = new Map();
  let stopping = false;
  // opts.onStderr, when given, is handed each new child's stderr (opts.stdio must pipe it), restarts included.
  function start(label, cmd, args, opts = {}, meta = {}) {
    const e = kids.get(label) ?? { label, meta, restarts: [], last_exit: null };
    kids.set(label, e);
    const { onStderr, ...spawnOpts } = opts;
    e.child = spawnFn(cmd, args, spawnOpts);
    if (onStderr) onStderr(e.child.stderr);
    e.up = true;
    e.started_at = new Date(now()).toISOString();
    e.child.on("error", (err) => log(`studio: ${label} could not start — ${err.message}`));
    e.child.on("exit", (code, signal) => {
      e.up = false;
      e.last_exit = { code, signal, at: new Date(now()).toISOString() };
      if (stopping || e.removed) return;
      log(`studio: ${label} exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      const t = now();
      e.restarts = e.restarts.filter((x) => t - x < windowMs);
      if (e.restarts.length >= maxRestarts) {
        log(
          `studio: ${label} exited ${maxRestarts + 1} times in ${Math.round(windowMs / 60000)} min; stopping the studio so its own supervisor restarts it whole`,
        );
        stop("SIGTERM");
        return onGiveUp(label);
      }
      e.restarts.push(t);
      const wait = backoff(e.restarts.length);
      log(`studio: restarting ${label} in ${wait / 1000} s`);
      schedule(() => {
        if (!stopping && !e.removed) start(label, cmd, args, opts, meta);
      }, wait);
    });
    return e;
  }
  function stop(sig = "SIGTERM") {
    stopping = true;
    for (const e of kids.values()) {
      try {
        if (e.up) e.child.kill(sig);
      } catch {}
    }
  }
  function remove(label) {
    const e = kids.get(label);
    if (!e) return;
    e.removed = true;
    kids.delete(label);
    try {
      if (e.up) e.child.kill("SIGTERM");
    } catch {}
  }
  const health = () =>
    [...kids.values()].map((e) => ({
      label: e.label,
      ...e.meta,
      up: Boolean(e.up),
      pid: e.up ? e.child.pid : null,
      started_at: e.started_at,
      restarts_recent: e.restarts.length,
      last_exit: e.last_exit,
    }));
  return {
    start,
    stop,
    remove,
    health,
    get stopping() {
      return stopping;
    },
  };
}

// Is something listening on a loopback port (a child can be 'up' and not serving yet, or serving and hung).
export const listening = (port, timeoutMs = 400) =>
  new Promise((resolve) => {
    if (!port) return resolve(null);
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
