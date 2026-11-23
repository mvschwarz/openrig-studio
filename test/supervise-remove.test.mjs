import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSupervisor } from "../tools/supervise.mjs";

test("retiring a replaced custom provider cancels its queued restart and preserves other children", () => {
  const children = [],
    timers = [];
  const supervisor = createSupervisor({
    spawnFn: () => {
      const child = new EventEmitter();
      child.pid = 100 + children.length;
      child.kill = (signal) => child.emit("exit", null, signal);
      children.push(child);
      return child;
    },
    schedule: (fn) => timers.push(fn),
    log: () => {},
  });
  supervisor.start("old-custom", "node", ["one"]);
  supervisor.start("unchanged", "node", ["two"]);
  children[0].emit("exit", 1, null);
  assert.equal(timers.length, 1);
  supervisor.remove("old-custom");
  timers[0]();
  assert.equal(children.length, 2);
  assert.deepEqual(
    supervisor.health().map((c) => [c.label, c.up]),
    [["unchanged", true]],
  );
  supervisor.start("new-custom", "node", ["three"]);
  supervisor.remove("new-custom");
  assert.equal(timers.length, 1);
  assert.deepEqual(
    supervisor.health().map((c) => c.label),
    ["unchanged"],
  );
  supervisor.stop();
});
