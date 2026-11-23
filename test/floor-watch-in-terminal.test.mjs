// The Floor's open work: "Watch in terminal" opens a task's agents in the Terminal's agents view (#agents&view=qitem:<id>; Boundary 2),
// only on a box whose Studio says it has that view (GET /api/studio/place: agents.watch), only on open work, only for an id in the
// task view's shape. Run as the page runs: the surface's own script in a vm with just enough of a page (as floor-open-in-files does).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs
  .readFileSync(path.join(REPO, "app", "surfaces", "floor.html"), "utf8")
  .match(/<script>([\s\S]*)<\/script>/)[1];
const ID = "task-20261027090146-ed1bba28dc65b628";
const open = (id = ID) => ({
  id,
  state: "in-progress",
  title: "Fix the login",
  source: "you@acme-team",
  destination: "acme-lead@acme-team",
});
const done = {
  id: "task-20261026100000-done",
  state: "done",
  title: "Sales summary",
  source: "you@acme-team",
  destination: "acme-lead@acme-team",
  closedAt: "2026-10-26T10:00:00.000Z",
  decision: { reason: "no-follow-on", target: null },
  result: "Wrote it",
  resultRead: true,
  resolution: null,
  artifact: null,
};
const STATE = (queue) => ({
  ok: true,
  rig: "acme-team",
  generatedAt: "2026-10-27T10:01:00.000Z",
  attached: true,
  seats: [],
  queue,
  done: { rows: [done], coverage: { looked: 1, ours: 1, shown: 1, limit: 100 } },
});
const PLACE = {
  label: "Pat's workspace",
  account: null,
  desktop: null,
  terminal: "/terminal/",
  agents: { watch: "/agents/watch/", type: "/agents/type/" },
};

// place: a body for /api/studio/place, { status } for an HTTP answer without one, "held" to answer later with calls.release(body).
function page({ state, place = PLACE }) {
  const el = () => ({
    innerHTML: "",
    textContent: "",
    value: "",
    className: "",
    lastElementChild: { textContent: "" },
    hidden: false,
    listeners: {},
    addEventListener(t, fn) {
      this.listeners[t] = fn;
    },
    querySelectorAll() {
      return [];
    },
  });
  const els = Object.fromEntries(
    [
      "#content",
      "#rig",
      "#updated",
      "#connection",
      "#find",
      "#found",
      "#findbox",
      "#nomatch-open",
      "#nomatch-done",
      ".eyebrow",
    ].map((s) => [s, el()]),
  );
  const calls = { place: 0, posted: [], release: null };
  const answer = (body, status = 200) =>
    Promise.resolve({ ok: status < 300, status, json: async () => body });
  const ctx = {
    document: { querySelector: (s) => els[s] },
    console,
    location: { origin: "http://127.0.0.1:9320", reload() {} },
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    localStorage: { getItem: () => null },
    addEventListener() {},
    fetch: (url) => {
      if (url === "/api/contract")
        return answer({
          contractVersion: "0.1",
          capabilities: ["observe.factory-state", "stream.events"],
        });
      if (url === "/surfaces.json") return answer({});
      if (url === "/api/factory/state") return answer(state);
      if (url === "/api/files/roots") return answer({ ok: false }, 404);
      if (url === "/api/studio/place") {
        calls.place++;
        if (place === "held")
          return new Promise((resolve) => {
            calls.release = (body) => resolve({ ok: true, status: 200, json: async () => body });
          });
        return place.status ? answer({}, place.status) : answer(place);
      }
      return answer({});
    },
    EventSource: function () {
      return { close() {}, addEventListener() {} };
    },
  };
  ctx.parent = { postMessage: (m, origin) => calls.posted.push({ m, origin }) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const html = () => els["#content"].innerHTML;
  const click = (a) => {
    let prevented = false;
    els["#content"].listeners.click({
      target: { closest: (sel) => (sel === "a[data-surface]" ? a : null) },
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  return { html, calls, click };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const LINK =
  /<a class="watch-open" href="([^"]*)" target="_top" data-surface="terminal" data-hash="([^"]*)">Watch in terminal<\/a>/g;

test("CONTROL: an open task gets 'Watch in terminal' to its agents view when the box has one; finished work doesn't", async () => {
  const p = page({ state: STATE([open()]) });
  await settle();
  const all = [...p.html().matchAll(LINK)];
  assert.equal(all.length, 1, "one link: the open task only, not the finished one");
  const hash = `#agents&view=${encodeURIComponent(`qitem:${ID}`)}`;
  assert.equal(all[0][2].replace(/&amp;/g, "&"), hash, "the attribute, as the browser reads it");
  assert.equal(all[0][1], "/?s=terminal&amp;h=" + encodeURIComponent(hash));
  const arrived = new URL(all[0][1].replace(/&amp;/g, "&"), "http://fixture").searchParams.get("h");
  assert.equal(decodeURIComponent(arrived.split("view=")[1]), `qitem:${ID}`);
  assert.ok(p.click({ dataset: { surface: "terminal", hash } }), "the shell switches in place");
  // (the message is made in the page's vm, so it's compared as data)
  assert.deepEqual(
    JSON.parse(JSON.stringify(p.calls.posted.at(-1))),
    { m: { t: "open-surface", id: "terminal", hash }, origin: "http://127.0.0.1:9320" },
    "this origin only",
  );
});

// The classic shell opens a surface at a place only through its PLACE filter.
const SHELL = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");
const PLACE_FILTER = SHELL.match(/const PLACE = (\/\^#\[.*?\]\{0,\d+\}\$\/);/);
test("the link's place survives the classic shell's own filter, as an address and as a posted hash", async () => {
  assert.ok(PLACE_FILTER, "the classic shell has its open-at-place filter");
  const p = page({ state: STATE([open()]) });
  await settle();
  const [link] = [...p.html().matchAll(LINK)];
  const allowed = new Function(`return ${PLACE_FILTER[1]}`)();
  const hash = `#agents&view=${encodeURIComponent(`qitem:${ID}`)}`;
  assert.ok(
    allowed.test(new URL(link[1].replace(/&amp;/g, "&"), "http://fixture").searchParams.get("h")),
    "the address survives",
  );
  assert.ok(allowed.test(hash), "the posted hash survives");
});

test("CONTROL: no agents view on this box (watch null), a Studio without the place route, or an id not in the task view's shape: no link", async () => {
  for (const [why, place, id] of [
    ["watch null", { ...PLACE, agents: { watch: null, type: null } }, ID],
    ["no place route", { status: 404 }, ID],
    ["an id outside the shape", PLACE, "qitem 1<x>"],
    ["an id starting with a dot", PLACE, ".hidden"],
  ]) {
    const p = page({ state: STATE([open(id)]), place });
    await settle();
    assert.doesNotMatch(p.html(), /watch-open/, why);
  }
});

test("the link arrives with a late answer, drawn on the answer on screen", async () => {
  const p = page({ state: STATE([open()]), place: "held" });
  await settle();
  assert.doesNotMatch(p.html(), /watch-open/, "not before the box says it has the view");
  p.calls.release(PLACE);
  await settle();
  assert.match(p.html(), /watch-open/);
});

test("below 600px it is Open in Files' small button (36px high, a 44px tap area); wide, the text link", () => {
  const css = fs
    .readFileSync(path.join(REPO, "app", "surfaces", "floor.html"), "utf8")
    .match(/<style>([\s\S]*?)<\/style>/)[1];
  const narrow = css.slice(css.indexOf("@media (max-width: 600px)"));
  assert.match(
    narrow,
    /\.watch-open \{[^}]*min-height: 36px;[^}]*font-size: 14px;/,
    "the button below 600px",
  );
  assert.match(
    narrow,
    /\.watch-open::after \{ content: ""; position: absolute; inset: -4px 0; \}/,
    "the 44px tap area",
  );
  const wide = css.slice(0, css.indexOf("@media (max-width: 600px)"));
  assert.match(wide, /\.watch-open \{ color: var\(--working\);/, "the text link, wide");
});
