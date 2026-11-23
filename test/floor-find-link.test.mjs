import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const script = fs
  .readFileSync(new URL("../app/surfaces/floor.html", import.meta.url), "utf8")
  .match(/<script>([\s\S]*)<\/script>/)[1]
  .replace(/\bboot\(\);\s*$/, "");
function page(hash) {
  const elements = new Map(),
    handlers = new Map();
  const el = (s) => {
    if (!elements.has(s))
      elements.set(s, {
        innerHTML: "",
        textContent: "",
        value: "",
        hidden: false,
        className: "",
        lastElementChild: { textContent: "" },
        addEventListener() {},
        querySelectorAll: () => [],
      });
    return elements.get(s);
  };
  const ctx = {
    document: { querySelector: el },
    location: { hash, reload() {} },
    URLSearchParams,
    addEventListener: (k, f) => handlers.set(k, f),
    fetch: () => new Promise(() => {}),
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    EventSource: function () {},
    parent: { postMessage() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const state = {
    ok: true,
    rig: "demo",
    attached: true,
    seats: [
      { seat: "writer@demo", pod: "work", member: "writer", state: "idle", lifecycle: "running" },
    ],
    queue: [],
    done: {
      rows: [
        {
          id: "task-demo-done",
          title: "Fixture result",
          source: "customer@demo",
          destination: "writer@demo",
          result: "Done",
          resultRead: true,
        },
      ],
      coverage: {},
    },
  };
  ctx.state = state;
  return {
    ctx,
    el,
    render: () => vm.runInContext("render(state)", ctx),
    hash: (h) => {
      ctx.location.hash = h;
      handlers.get("hashchange")();
    },
  };
}
test("initial and changed q links use Find; refresh keeps typing; removing q clears it", () => {
  const p = page("#q=task-demo-done");
  assert.equal(p.el("#find").value, "task-demo-done");
  p.render();
  assert.equal(p.el("#found").textContent, "0 open, 1 finished");
  p.el("#find").value = "typed";
  p.render();
  assert.equal(p.el("#find").value, "typed");
  p.hash("#q=task-not-loaded");
  assert.match(p.el("#found").textContent, /older finished work isn't searched/);
  p.hash("#q=task-demo-done");
  assert.equal(p.el("#found").textContent, "0 open, 1 finished");
  p.hash("");
  assert.equal(p.el("#find").value, "");
  assert.equal(p.el("#found").textContent, "");
});
test("link matching retains the rig boundary", () => {
  const p = page("#q=task-demo-done");
  p.ctx.state.done.rows[0].destination = "other@elsewhere";
  p.ctx.state.done.rows[0].source = "other2@elsewhere";
  p.render();
  assert.match(p.el("#found").textContent, /No work with that id/);
});
