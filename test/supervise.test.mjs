// The box's children are supervised: every exit logged with code AND signal, restarted with backoff, and a child that
// keeps dying stops the box for its own supervisor. (A signal-killed provider once died silently.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { createSupervisor, backoff, listening } from "../tools/supervise.mjs";

function harness(opts = {}) {
  let t = 0,
    pid = 100;
  const logs = [],
    spawned = [],
    timers = [],
    gaveUp = [];
  const spawnFn = (cmd, args) => {
    const c = new EventEmitter();
    c.pid = ++pid;
    c.killed = [];
    c.kill = (s) => {
      c.killed.push(s);
    };
    spawned.push({ cmd, args, c });
    return c;
  };
  const sup = createSupervisor({
    spawnFn,
    log: (m) => logs.push(m),
    now: () => t,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    onGiveUp: (l) => gaveUp.push(l),
    ...opts,
  });
  return {
    sup,
    logs,
    spawned,
    timers,
    gaveUp,
    advance: (ms) => {
      t += ms;
    },
    fire: () => {
      const x = timers.shift();
      x.fn();
      return x.ms;
    },
  };
}

test("a signal-killed child is logged with its signal (no longer silent) and restarted on the same command after a backoff", () => {
  const h = harness();
  h.sup.start(
    "@openrig/studio-hosts",
    "node",
    ["hosts-server.mjs", "--port", "9324"],
    {},
    { kind: "provider", port: 9324 },
  );
  h.spawned[0].c.emit("exit", null, "SIGTERM");
  assert.ok(
    h.logs.some((l) => l.includes("@openrig/studio-hosts exited (code none, signal SIGTERM)")),
  );
  assert.equal(h.fire(), 1000, "first restart after 1 s");
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(h.spawned[1].args, ["hosts-server.mjs", "--port", "9324"]);
  const [c] = h.sup.health();
  assert.deepEqual(
    [c.label, c.kind, c.port, c.up, c.pid, c.restarts_recent, c.last_exit.signal],
    ["@openrig/studio-hosts", "provider", 9324, true, h.spawned[1].c.pid, 1, "SIGTERM"],
  );
  h.spawned[1].c.emit("exit", 1, null);
  assert.ok(h.logs.some((l) => l.includes("exited (code 1, signal none)")));
  assert.equal(h.fire(), 2000, "backoff doubles");
  assert.deepEqual([1, 2, 3, 6, 9].map(backoff), [1000, 2000, 4000, 30000, 30000]);
});

test("more than five exits inside five minutes stops the whole box (for launchd), rather than flapping forever", () => {
  const h = harness();
  h.sup.start("p", "node", ["a"]);
  h.sup.start("other", "node", ["b"]);
  for (let i = 0; i < 5; i++) {
    h.spawned
      .filter((s) => s.args[0] === "a")
      .at(-1)
      .c.emit("exit", null, "SIGKILL");
    h.fire();
    h.advance(10000);
  }
  h.spawned
    .filter((s) => s.args[0] === "a")
    .at(-1)
    .c.emit("exit", null, "SIGKILL");
  assert.deepEqual(h.gaveUp, ["p"]);
  assert.equal(h.timers.length, 0, "no further restart scheduled");
  assert.deepEqual(
    h.spawned.find((s) => s.args[0] === "b").c.killed,
    ["SIGTERM"],
    "the other children are stopped too",
  );
  // ...but exits spread over longer than the window keep restarting
  const g = harness();
  g.sup.start("p", "node", ["a"]);
  for (let i = 0; i < 8; i++) {
    g.spawned.at(-1).c.emit("exit", null, "SIGTERM");
    g.fire();
    g.advance(6 * 60000);
  }
  assert.deepEqual(g.gaveUp, []);
});

test("a deliberate stop restarts nothing and logs no false failure", () => {
  const h = harness();
  h.sup.start("p", "node", ["a"]);
  h.sup.stop("SIGTERM");
  assert.deepEqual(h.spawned[0].c.killed, ["SIGTERM"]);
  h.spawned[0].c.emit("exit", null, "SIGTERM");
  assert.equal(h.timers.length, 0);
  assert.equal(h.logs.length, 0);
  assert.equal(h.sup.health()[0].up, false);
});

test("listening() tells a serving port from a dead one", async () => {
  const srv = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = srv.address().port;
  assert.equal(await listening(port), true);
  srv.close();
  await new Promise((r) => srv.once("close", r));
  assert.equal(await listening(port), false);
  assert.equal(await listening(undefined), null);
});
