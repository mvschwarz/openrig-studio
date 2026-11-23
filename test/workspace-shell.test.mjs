import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const html = fs.readFileSync(new URL("../app/shell.html", import.meta.url), "utf8");
function fixture() {
  const block = html.match(
    /\/\/ BEGIN WORKSPACE SURFACE PROTOCOL([\s\S]*?)\/\/ END WORKSPACE SURFACE PROTOCOL/,
  );
  assert.ok(block, "the workspace protocol is present");
  const listeners = {},
    sent = [],
    classes = new Set();
  let reloads = 0;
  const frame = { postMessage: (data, origin) => sent.push({ data, origin }) },
    other = { postMessage: () => {} };
  const location = {
    href: "https://studio.example/?s=requests",
    origin: "https://studio.example",
    reload: () => reloads++,
  };
  const history = {
    state: { s: "requests" },
    pushState: (s, x, url) => {
      history.state = s;
      location.href = String(url);
    },
    replaceState: (s, x, url) => {
      history.state = s;
      location.href = String(url);
    },
  };
  const ctx = {
    activeId: "requests",
    workspaceLayouts: new Map(),
    workspaceRoutes: new Map(),
    frames: new Map([
      ["requests", { contentWindow: frame }],
      ["files", { contentWindow: other }],
    ]),
    surfaces: [
      { id: "requests", name: "Requests" },
      { id: "files", name: "Files" },
    ],
    byId: (id) => ctx.surfaces.find((s) => s.id === id),
    activate: (id) => {
      ctx.activeId = id;
    },
    location,
    history,
    URL,
    document: {
      body: {
        classList: {
          toggle: (key, on) => (on ? classes.add(key) : classes.delete(key)),
          contains: (key) => classes.has(key),
        },
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: (key, fn) => (listeners[key] = fn),
    },
    addEventListener: (key, fn) => (listeners[key] = fn),
  };
  vm.runInNewContext(block[1], ctx);
  return {
    ctx,
    frame,
    other,
    sent,
    classes,
    location,
    reloads: () => reloads,
    emit: (data, source = frame, origin = location.origin) =>
      listeners.message({ data, source, origin }),
  };
}
test("workspace layout is opt-in and only the active same-origin surface changes it", () => {
  const f = fixture();
  f.emit({ t: "surface-layout", layout: "workspace" }, f.other);
  assert.equal(f.classes.size, 0);
  f.emit({ t: "surface-layout", layout: "workspace" }, f.frame, "https://app.example");
  assert.equal(f.classes.size, 0);
  f.emit({ t: "surface-layout", layout: "workspace" });
  assert.ok(f.classes.has("workspace-canvas"));
  f.emit({ t: "surface-layout", layout: "default" });
  assert.equal(f.classes.size, 0);
});
test("opaque route state is in browser history, with the frame retained", () => {
  const f = fixture();
  f.emit({ t: "surface-route", value: "request-one" });
  assert.equal(new URL(f.location.href).searchParams.get("view"), "request-one");
  assert.equal(f.ctx.frames.get("requests").contentWindow, f.frame);
  assert.equal(f.sent.at(-1).data.t, "workspace-context");
  f.emit({ t: "surface-route", value: "request-two", replace: true });
  assert.equal(f.ctx.history.state.view, "request-two");
});
test("context includes declared navigation only, and reload remains an explicit active-surface action", () => {
  const f = fixture();
  f.emit({ t: "workspace-context" });
  assert.equal(f.sent.at(-1).data.surfaces.length, 2);
  f.emit({ t: "reload-workspace" }, f.other);
  assert.equal(f.reloads(), 0);
  f.emit({ t: "reload-workspace" });
  assert.equal(f.reloads(), 1);
});

test("an active surface opens a declared workspace at an opaque view without replacing its frame", () => {
  const f = fixture();
  f.emit({ t: "open-surface-view", id: "files", value: "selected-item" }, f.other);
  assert.equal(f.ctx.activeId, "requests");
  f.emit({ t: "open-surface-view", id: "missing", value: "x" });
  assert.equal(f.ctx.activeId, "requests");
  f.emit({ t: "open-surface-view", id: "files", value: "x".repeat(513) });
  assert.equal(f.ctx.activeId, "requests");
  f.emit({ t: "open-surface-view", id: "files", value: "selected-item" });
  assert.equal(f.ctx.activeId, "files");
  assert.equal(f.ctx.workspaceRoutes.get("files"), "selected-item");
  assert.equal(f.ctx.frames.get("files").contentWindow, f.other);
});
