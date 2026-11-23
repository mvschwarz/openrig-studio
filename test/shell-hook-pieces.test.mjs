// The shell's pieces a server hook relies on (app/shell.html): the #rail-private slot, the sign-in renewal and the chat
// panel's import. Each block is run on its own against stand-ins for the page, the way test/workspace-shell.test.mjs runs
// the workspace protocol; no browser is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../app/shell.html", import.meta.url), "utf8");
const block = (name) => {
  const m = html.match(new RegExp(`// BEGIN ${name}([\\s\\S]*?)// END ${name}`));
  assert.ok(m, `${name} is present`);
  return m[1];
};

// A small stand-in for the DOM: elements by id, classes on body, children appended and removed.
function page() {
  const byId = new Map();
  const classes = new Set();
  const listeners = {};
  const el = (tag) => {
    const e = {
      tagName: tag.toUpperCase(),
      id: "",
      attrs: {},
      children: [],
      textContent: "",
      classList: {
        set: new Set(),
        add: (c) => e.classList.set.add(c),
        toggle: (c, on) => (on ? e.classList.set.add(c) : e.classList.set.delete(c)),
        contains: (c) => e.classList.set.has(c),
      },
      setAttribute: (k, v) => (e.attrs[k] = v),
      getAttribute: (k) => e.attrs[k] ?? null,
      append: (...xs) => {
        for (const x of xs) {
          e.children.push(x);
          if (x.id) byId.set(x.id, x);
        }
      },
      remove: () => byId.delete(e.id),
      replaceWith: (x) => byId.set(x.id, x),
      focus: () => {},
      addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn), undefined),
    };
    return e;
  };
  const body = el("body");
  body.classList = {
    add: (c) => classes.add(c),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    contains: (c) => classes.has(c),
  };
  body.append = (...xs) => {
    for (const x of xs) if (x.id) byId.set(x.id, x);
  };
  const metas = [];
  const document = {
    body,
    createElement: el,
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: (sel) =>
      sel === 'meta[name="openrig-chat-panel"][content="none"]' && metas.includes("none")
        ? {}
        : null,
  };
  return { document, byId, classes, metas, el, listeners };
}

test("the rail has an empty #rail-private slot above its foot, hidden while empty", () => {
  const rail = html.slice(html.indexOf('<nav id="rail">'), html.indexOf("</nav>"));
  const health = rail.indexOf('<div id="manifest-health"></div>');
  const slot = rail.indexOf('<div id="rail-private"></div>');
  const foot = rail.indexOf('<div id="rail-foot">');
  assert.ok(
    health > 0 && slot > health && foot > slot,
    "between the health line and the foot, empty",
  );
  assert.match(html, /#rail-private:empty \{ display: none; \}/);
});

function renewal({ answers, storage = new Map() }) {
  const p = page();
  let reloads = 0;
  const asked = [];
  const frames = new Map([
    ["terminal", { src: "https://box.example/surfaces/terminal.html", remove() {} }],
    ["files", { src: "https://box.example/surfaces/files.html", remove() {} }],
  ]);
  const chatframe = p.el("iframe");
  chatframe.id = "chatframe";
  chatframe.setAttribute("src", "https://box.example/chat/?arg=x");
  p.byId.set("chatframe", chatframe);
  const placed = new Map([["terminal", "#agents"]]);
  const ctx = {
    document: p.document,
    frames,
    placed,
    renewingSignIn: false,
    location: { href: "https://box.example/", reload: () => reloads++ },
    sessionStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
    },
    AbortSignal: { timeout: () => undefined },
    URL,
    Date,
    Number,
    String,
    fetch: async (url, opts) => {
      asked.push({ url, ...opts });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return {
        status: a.status ?? 0,
        type: a.type ?? "basic",
        ok: (a.status ?? 0) >= 200 && (a.status ?? 0) < 300,
        headers: { get: (k) => (a.headers ?? {})[k] ?? null },
      };
    },
  };
  vm.runInNewContext(block("SIGN-IN RENEWAL"), ctx);
  return {
    ctx,
    p,
    asked,
    frames,
    reloads: () => reloads,
    notice: () => p.byId.get("signInEnded") ?? null,
    check: () => ctx.checkSignIn(),
  };
}

test("sign-in renewal: a renewable refusal reloads once (terminals released first); refused again within 30 s, the notice", async () => {
  const storage = new Map();
  const a = renewal({
    answers: [{ status: 403, headers: { "x-openrig-front-door": "renew" } }],
    storage,
  });
  await a.check();
  assert.equal(a.reloads(), 1);
  assert.equal(a.ctx.renewingSignIn, true);
  assert.equal(a.notice(), null);
  assert.equal(a.frames.has("terminal"), false, "a terminal frame is removed before the reload");
  assert.equal(
    a.ctx.placed.has("terminal"),
    false,
    "and the place the shell put it at is forgotten with it",
  );
  assert.equal(a.frames.has("files"), true);
  assert.equal(a.p.byId.get("chatframe").getAttribute("src"), null, "the seat frame is released");
  assert.deepEqual(
    {
      url: a.asked[0].url,
      method: a.asked[0].method,
      redirect: a.asked[0].redirect,
      credentials: a.asked[0].credentials,
    },
    { url: "/api/studio/place", method: "HEAD", redirect: "manual", credentials: "same-origin" },
  );
  // The reloaded page is refused for renewal again within the window: no second reload, the notice instead.
  const b = renewal({
    answers: [{ status: 403, headers: { "x-openrig-front-door": "renew" } }],
    storage,
  });
  await b.check();
  assert.equal(b.reloads(), 0);
  assert.ok(b.notice(), "the notice");
});

test("sign-in renewal: a redirect, 401 or a closed 403 shows one notice; an answer again takes it away; no answer changes nothing", async () => {
  for (const ended of [
    { type: "opaqueredirect" },
    { status: 401 },
    { status: 403, headers: { "x-openrig-front-door": "closed" } },
  ]) {
    const r = renewal({ answers: [ended, ended, { status: 200 }, new Error("offline")] });
    await r.check();
    const n = r.notice();
    assert.ok(n, JSON.stringify(ended));
    assert.equal(r.reloads(), 0);
    const title = n.children[0].children.find((c) => c.tagName === "H2");
    assert.equal(title.textContent, "Your sign-in has ended");
    await r.check();
    assert.equal(r.notice(), n, "one notice, not two");
    await r.check();
    assert.equal(r.notice(), null, "back in: the notice goes");
    await r.check();
    assert.equal(r.notice(), null);
  }
  // A Studio with no sign-in in front just answers.
  const local = renewal({ answers: [{ status: 200 }] });
  await local.check();
  assert.equal(local.notice(), null);
  assert.equal(local.reloads(), 0);
});

function panel({ metas = [], seats = [], load }) {
  const p = page();
  p.metas.push(...metas);
  const toggle = p.el("button");
  toggle.id = "agentToggle";
  toggle.textContent = "AGENTS ▸";
  p.byId.set("agentToggle", toggle);
  const title = p.el("span");
  title.id = "topTitle";
  p.byId.set("topTitle", title);
  const stage = p.el("main");
  const activated = [];
  const ctx = {
    document: p.document,
    seats,
    stage,
    tabsEl: { children: [] },
    activeId: "files",
    surfaces: [
      { id: "files", name: "Files" },
      { id: "notes", name: "Notes" },
    ],
    byId: (id) => ctx.surfaces.find((s) => s.id === id),
    activate: (id) => activated.push(id),
    appChat: null,
  };
  vm.runInNewContext(block("CHAT PANEL"), ctx);
  return { ctx, p, toggle, stage, activated, mount: () => ctx.mountChatPanel(load) };
}

test("the shell never carries the no-panel meta tag itself: finding it in a page means a transform added it", () => {
  assert.equal(html.includes('<meta name="openrig-chat-panel"'), false);
});

test("chat panel: the meta turns the import off; with no seats either, the agents button goes too", async () => {
  let loads = 0;
  const load = async () => (loads++, { mount() {} });
  const none = panel({ metas: ["none"], load });
  assert.equal(await none.mount(), null);
  assert.equal(none.p.classes.has("no-agent-route"), true);
  const withSeats = panel({ metas: ["none"], seats: [{ seat: "a@r" }], load });
  await withSeats.mount();
  assert.equal(withSeats.p.classes.has("no-agent-route"), false, "seats keep the roster button");
  assert.equal(loads, 0, "never asked for");
});

test("chat panel: imported from the provider path and mounted; a contextual one becomes the Agent button and follows the apps", async () => {
  const opened = [];
  const mounted = [];
  const fake = (contextual) => ({
    mount(opts) {
      mounted.push(opts);
      return {
        ready: Promise.resolve(),
        roster: () => ({ contextual }),
        open: () => opened.push(1),
      };
    },
  });
  let asked = null;
  const plain = panel({ load: async (u) => ((asked = u), fake(false)) });
  await plain.mount();
  assert.equal(asked, "/collab-assets/chat-panel/panel.js");
  assert.equal(mounted[0].app, "files");
  assert.equal(mounted[0].root, plain.stage);
  assert.equal(mounted[0].workspace, true);
  assert.equal(mounted[0].initialOpen, false);
  assert.equal(plain.ctx.appChat, null, "not contextual: the shell's own roster stays");
  assert.equal(plain.toggle.textContent, "AGENTS ▸");

  const ctxual = panel({ load: async () => fake(true) });
  const p = await ctxual.mount();
  assert.equal(ctxual.ctx.appChat, p);
  assert.equal(ctxual.p.classes.has("workspace-chat"), true);
  assert.equal(ctxual.toggle.textContent, "Agent");
  ctxual.toggle.onclick();
  assert.equal(opened.length, 1);
  for (const fn of ctxual.p.listeners["chat:surface"])
    fn({ target: { id: "chat-panel" }, detail: { id: "notes" } });
  for (const fn of ctxual.p.listeners["chat:surface"])
    fn({ target: { id: "chat-panel" }, detail: { id: "nowhere" } });
  assert.deepEqual(ctxual.activated, ["notes"], "only an app this shell has");
  for (const fn of ctxual.p.listeners["chat:view"])
    fn({ target: { id: "chat-panel" }, detail: { open: true } });
  assert.equal(ctxual.p.byId.get("topTitle").textContent, "Conversation");

  // A panel that can't be loaded leaves the shell as it was.
  const broken = panel({
    load: async () => {
      throw new Error("404");
    },
  });
  assert.equal(await broken.mount(), null);
  assert.equal(broken.toggle.textContent, "AGENTS ▸");
});

test("live app discovery keeps updating while one app.json is bad, and the rail says so as it does at load", async () => {
  // The runtime is warn-first: with one app's row invalid, /api/contract says manifest.ok false and /surfaces.json still
  // serves every valid row. Discovery must take those rows (a new app appears) and show the manifest's errors, not stop.
  const health = { className: "", textContent: "" };
  const routes = {
    "/api/contract": {
      manifest: { ok: false, errors: ["broken: app.json is not valid JSON"], warnings: [] },
    },
    "/surfaces.json": {
      surfaces: [
        { id: "base", name: "Base", path: "/surfaces/base.html" },
        { id: "fresh", name: "Fresh", path: "/surfaces/fresh.html" },
      ],
    },
  };
  let rendered = 0;
  const ctx = {
    health,
    location: { origin: "http://127.0.0.1:1" },
    URL,
    AbortSignal,
    fetch: async (u) => ({ ok: true, status: 200, json: async () => routes[u] }),
    renewSignIn: () => false,
    signInHasEnded: () => false,
    noticeSignInEnded: () => {},
    renewingSignIn: false,
    meta: null,
    surfaces: [
      {
        id: "base",
        name: "Base",
        path: "/surfaces/base.html",
        url: "http://127.0.0.1:1/surfaces/base.html",
      },
    ],
    loadedSurfaces: new Map(),
    frames: new Map(),
    reg: {},
    activeId: "base",
    byId: (id) => ctx.surfaces.find((s) => s.id === id),
    renderTabs: () => rendered++,
    notifyWorkspace: () => {},
    setInterval: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(
    block("MANIFEST HEALTH") + block("LIVE APP DISCOVERY") + ";this.discoverApps = discoverApps;",
    ctx,
  );
  await ctx.discoverApps();
  assert.deepEqual(
    ctx.surfaces.map((s) => s.id),
    ["base", "fresh"],
    "the new app reached the rail",
  );
  assert.equal(rendered, 1);
  assert.equal(health.className, "bad");
  assert.equal(health.textContent, "manifest: 1 error(s) — see /api/contract");
  routes["/api/contract"] = { manifest: { ok: true, errors: [], warnings: [] } };
  await ctx.discoverApps();
  assert.equal(health.className, "");
  assert.equal(health.textContent, "manifest ok", "and it clears once the app.json is fixed");
});
