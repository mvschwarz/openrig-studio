// The Floor below 600px: Seats and Queue stack like Done recently: the seat or the work on top, then one muted line, with the words their column heads gave
// (age, pending, from, to) shown only there; and the two small buttons (Open in Files, Watch in terminal) carry no underline.
// Wide, both tables are as before. The CSS is read from the page; the markup is the surface's own script run in a vm.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(REPO, "app", "surfaces", "floor.html"), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const NARROW = css.slice(css.indexOf("@media (max-width: 600px)")),
  WIDE = css.slice(0, css.indexOf("@media (max-width: 600px)"));
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function render(state) {
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
    fetch: (url) =>
      url === "/api/contract"
        ? answer({
            contractVersion: "0.1",
            capabilities: ["observe.factory-state", "stream.events"],
          })
        : url === "/api/factory/state"
          ? answer(state)
          : url === "/api/studio/place"
            ? answer({}, 404)
            : answer({}, 404),
    EventSource: function () {
      return { close() {}, addEventListener() {} };
    },
  };
  ctx.parent = { postMessage() {} };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return () => els["#content"].innerHTML;
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const STATE = {
  ok: true,
  rig: "acme-team",
  generatedAt: "2026-10-27T14:00:00.000Z",
  attached: true,
  seats: [
    {
      seat: "acme.lead",
      pod: "acme",
      member: "lead",
      state: "working",
      lifecycle: "running",
      ageMinutes: 12,
      pendingWork: 2,
    },
    {
      seat: "you",
      customer: true,
      pod: "x",
      member: "y",
      state: "idle",
      lifecycle: "running",
      ageMinutes: 1,
      pendingWork: 0,
    },
  ],
  queue: [
    {
      id: "task-20261027140000-aaaa",
      state: "in-progress",
      title: "Fix the login",
      source: "you@acme-team",
      destination: "acme-lead@acme-team",
    },
  ],
};

test("CONTROL, below 600px: Seats and Queue are stacked blocks with one muted line, as Done recently is; wide they're tables as before", () => {
  for (const t of ["seats-table", "queue-table"]) {
    assert.match(
      NARROW,
      new RegExp(`table\\.seats-table, table\\.queue-table \\{ min-width: 0; \\}`),
      t,
    );
    assert.match(NARROW, /\.seats-table thead, \.queue-table thead \{ display: none; \}/);
    assert.match(NARROW, /\.seats-table tbody, \.queue-table tbody \{ display: block; \}/);
    assert.doesNotMatch(WIDE, new RegExp(`\\.${t}`), `${t}: nothing changes wide`);
  }
  assert.match(
    NARROW,
    /\.seats-table td, \.queue-table td \{[^}]*color: var\(--muted\);/,
    "the details on one muted line",
  );
  assert.match(NARROW, /\.seats-table td\.seat-name \{ flex: 0 0 100%;/, "the seat on top");
  assert.match(NARROW, /\.queue-table \.queue-name \{ flex: 0 0 100%;/, "the work on top");
  assert.match(
    NARROW,
    /\.seats-table td:empty \{ display: none; \}/,
    "the customer's own row takes no room for its empty cells",
  );
  assert.match(
    NARROW,
    /td:not\(\.seat-name\):not\(:last-child\)::after[^{]*\{ content: "\\00a0·"; \}/,
    "a dot ends the item before it",
  );
  assert.match(
    WIDE,
    /\.narrow-word \{ display: none; \}/,
    "the stacked-only words are hidden wide",
  );
  assert.match(
    NARROW,
    /\.seats-table \.narrow-word, \.queue-table \.narrow-word \{ display: inline; \}/,
    "and shown stacked",
  );
});

test("CONTROL, the stacked-only words: age and pending on Seats, from and to on Queue, in the markup the tables draw", async () => {
  const content = render(STATE);
  await settle();
  const h = content();
  assert.match(h, /<table class="seats-table" aria-label="Rig seats">/);
  assert.match(h, /<table class="queue-table" aria-label="Rig queue">/);
  assert.match(h, /<td class="numeric"><span class="narrow-word">age <\/span>12m<\/td>/);
  assert.match(h, /<td class="numeric">2<span class="narrow-word"> pending<\/span><\/td>/);
  assert.match(h, /<td class="route"><span class="narrow-word">from <\/span>you@acme-team<\/td>/);
  assert.match(
    h,
    /<td class="route"><span class="narrow-word">to <\/span>acme-lead@acme-team<\/td>/,
  );
  assert.doesNotMatch(
    h,
    /<td class="seat-name">you@acme-team<\/td>/,
    "the customer's own seat isn't a row",
  );
});

test("CONTROL, below 600px neither small button is underlined", () => {
  assert.match(NARROW, /\.done-table \.files-open \{[^}]*text-decoration: none;/, "Open in Files");
  assert.match(NARROW, /\.watch-open \{[^}]*text-decoration: none;/, "Watch in terminal");
  assert.doesNotMatch(WIDE, /text-decoration/, "wide, both stay text links");
});

test("CONTROL each part of the stacked line is one unit: an address or 'acme / lead' is never split, the line breaks between parts, inside one only when it is longer than the line", () => {
  assert.match(
    NARROW,
    /\.seats-table tr, \.queue-table tr \{ display: flex; flex-wrap: wrap;[^}]*column-gap: 1ch;/,
    "each cell is its own wrapping unit",
  );
  assert.match(
    NARROW,
    /\.seats-table td, \.queue-table td \{ min-width: 0;[^}]*overflow-wrap: anywhere; \}/,
    "a part longer than the line still wraps, never overflows",
  );
  assert.doesNotMatch(
    NARROW,
    /\.(seats|queue)-table td[^{]*\{[^}]*display: inline;/,
    "no cell is inline text that breaks mid-address",
  );
});

test("CONTROL a Queue item reads: the work, its id, the state line, then Watch in terminal last", async () => {
  assert.match(
    NARROW,
    /\.queue-table td\.queue-title \{ display: contents; \}/,
    "the title cell's parts join the row",
  );
  assert.match(NARROW, /\.queue-table \.item-id \{ flex: 0 0 100%;/);
  assert.match(
    NARROW,
    /\.queue-table \.watch-line \{ order: 1; flex: 0 0 100%; \}/,
    "the button after the state line",
  );
  const content = render(STATE);
  await settle();
  assert.match(
    content(),
    /<td class="queue-title"><span class="queue-name">Fix the login<\/span><\/td>/,
    "the title in its own unit (no ids or link in this state: no done, no place)",
  );
});
