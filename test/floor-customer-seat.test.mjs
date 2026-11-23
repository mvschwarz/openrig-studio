// A box's customer seat on the Floor: the provider keeps it in state.seats marked customer: true, so find-by-id still knows its
// work. It is the person's own entry, not an agent, so the Floor doesn't list it under Seats or count it as working or needing
// attention; its requests still show under Queue. A connected assistant's caller seats (member caller-<id>) are treated the same.
// A seat without the mark is drawn as before. The surface's own script, as test/floor-done.test.mjs runs it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surface = fs.readFileSync(path.join(REPO, "app", "surfaces", "floor.html"), "utf8");
const CALLER = "cus-acme-caller@acme-team";
const SEATS = [
  {
    seat: "acme-lead@acme-team",
    pod: "acme",
    member: "lead",
    state: "working",
    lifecycle: "running",
    ageMinutes: 12,
    pendingWork: 1,
  },
  {
    seat: CALLER,
    pod: "cus-acme",
    member: "caller",
    state: "down",
    lifecycle: "stopped",
    ageMinutes: null,
    pendingWork: 0,
    customer: true,
  },
];
const STATE = {
  ok: true,
  rig: "acme-team",
  generatedAt: "2026-10-26T10:50:00.000Z",
  attached: true,
  seats: SEATS,
  queue: [
    {
      id: "task-20261026104900-open",
      state: "pending",
      source: CALLER,
      destination: "acme-lead@acme-team",
      title: "Weekly summary",
      tags: [],
    },
  ],
  done: {
    rows: [
      {
        id: "task-20261026104000-done",
        state: "done",
        title: "Last week's summary",
        source: CALLER,
        destination: "acme-lead@acme-team",
        closedAt: "2026-10-26T10:40:00.000Z",
        decision: { reason: "no-follow-on", target: null },
        result: "Done",
        resultRead: true,
        resolution: null,
        artifact: null,
      },
    ],
    coverage: { looked: 1, ours: 1, shown: 1, limit: 100 },
  },
};

function page() {
  const rows = new Map();
  const rowsOf = (html) =>
    [...html.matchAll(/<tr data-id="([^"]+)"/g)].map(
      (m) => rows.get(m[1]) || rows.set(m[1], { dataset: { id: m[1] }, hidden: false }).get(m[1]),
    );
  const el = () => ({
    innerHTML: "",
    textContent: "",
    value: "",
    className: "",
    lastElementChild: { textContent: "" },
    hidden: false,
    addEventListener() {},
    querySelectorAll() {
      return rowsOf(this.innerHTML);
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
  const ctx = {
    document: { querySelector: (s) => els[s] },
    fetch: () => new Promise(() => {}),
    EventSource: function () {},
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    parent: { postMessage() {} },
    console,
    localStorage: { getItem: () => null },
    addEventListener() {},
    location: { reload() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(
    surface.match(/<script>([\s\S]*)<\/script>/)[1].replace(/\bboot\(\);\s*$/, ""),
    ctx,
  );
  return { ctx, els, rowsOf };
}
const seatsTable = (html) =>
  html.slice(html.indexOf("<h2>Seats"), html.indexOf("</section>", html.indexOf("<h2>Seats")));

test("CONTROL: the customer seat isn't listed under Seats or counted, and its request still shows under Queue", () => {
  const { ctx, els } = page();
  ctx.render(STATE);
  const h = els["#content"].innerHTML,
    seats = seatsTable(h);
  assert.match(seats, /<h2>Seats · 1<\/h2>/, "only the team's seat");
  assert.doesNotMatch(
    seats,
    /cus-acme-caller|cus-acme \/ caller|state-tag down|stopped/,
    "no row for the customer's own seat",
  );
  assert.match(
    seats,
    /acme-lead@acme-team[\s\S]*state-tag working/,
    "a team seat is drawn as before",
  );
  assert.match(h, /<b>1<\/b><span>working now<\/span>/);
  assert.match(
    h,
    /<b>0<\/b><span>need attention<\/span>/,
    "the customer's own 'down' seat isn't a team seat needing attention",
  );
  assert.match(
    h,
    /<span class="queue-name">Weekly summary<\/span>[\s\S]*cus-acme-caller@acme-team/,
    "its request is under Queue",
  );
});

test("a connected assistant's caller seat (member caller-<id>) isn't listed or counted either", () => {
  const { ctx, els } = page();
  const caller = {
    seat: "caller-7f3a@acme-team",
    pod: "gateway",
    member: "caller-7f3a",
    state: "down",
    lifecycle: "detached",
    ageMinutes: null,
    pendingWork: 0,
  };
  ctx.render({ ...STATE, seats: [SEATS[0], caller] });
  const h = els["#content"].innerHTML;
  assert.doesNotMatch(seatsTable(h), /caller-7f3a/);
  assert.match(h, /<b>0<\/b><span>need attention<\/span>/);
});

test("find-by-id still finds the customer's open and finished work (the seat stays in state.seats)", () => {
  const { ctx, els, rowsOf } = page();
  ctx.render(STATE);
  for (const [id, found] of [
    ["104900-open", "1 open, 0 finished"],
    ["104000-done", "0 open, 1 finished"],
  ]) {
    els["#find"].value = id;
    ctx.findWork();
    assert.equal(els["#found"].textContent, found, id);
    assert.ok(
      rowsOf(els["#content"].innerHTML).some((r) => !r.hidden && r.dataset.id.endsWith(id)),
      id,
    );
  }
  assert.match(
    els["#content"].innerHTML,
    /Done recently · 1/,
    "its finished work is under Done recently",
  );
});

test("a seat without the mark is unchanged, even one whose name looks like a customer's", () => {
  const { ctx, els } = page();
  ctx.render({ ...STATE, seats: SEATS.map(({ customer, ...s }) => s) });
  const h = els["#content"].innerHTML;
  assert.match(seatsTable(h), /cus-acme-caller@acme-team[\s\S]*state-tag down/);
  assert.match(h, /<b>1<\/b><span>need attention<\/span>/);
});
