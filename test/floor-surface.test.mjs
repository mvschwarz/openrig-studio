import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE = path.join(REPO, "app", "surfaces", "floor.html");
const surface = fs.readFileSync(SURFACE, "utf8");

test("FLOOR renders seats and queue as semantic tables instead of cards", () => {
  assert.match(surface, /<title>Rig Floor<\/title>/, "positive control: loaded the FLOOR surface");
  assert.equal((surface.match(/<table\b/g) || []).length, 3, "seats, queue and finished work");

  for (const heading of ["Seat", "Pod / member", "State", "Lifecycle", "Age", "Pending"]) {
    assert.match(surface, new RegExp(`<th[^>]*>${heading.replace(" / ", " \\/ ")}<\\/th>`, "i"));
  }

  for (const heading of ["Work", "State", "Source", "Destination"]) {
    assert.match(surface, new RegExp(`<th[^>]*>${heading}<\\/th>`, "i"));
  }

  assert.doesNotMatch(surface, /<article class="seat\b/);
  assert.doesNotMatch(surface, /<article class="queue-item\b/);
});

test("FLOOR keeps detached states distinct and always marks them down", () => {
  const start = surface.indexOf("if (state.attached === false)");
  const end = surface.indexOf("rig.textContent = state.rig", start);
  assert.notEqual(start, -1, "detached-state branch exists");
  assert.notEqual(end, -1, "attached-state branch follows detached handling");

  const detached = surface.slice(start, end);
  assert.match(detached, /'no-rig': 'No rig is running on this box\.'/);
  assert.match(detached, /'no-rig-cli': 'The rig CLI is not installed on this box\.'/);
  assert.match(detached, /'rig-error': 'The rig is installed but could not be read\.'/);
  assert.match(detached, /setConnection\('down'/);
  assert.doesNotMatch(detached, /setConnection\('live'/);
});

test("FLOOR keeps its declared welcome and delegated agent launcher", () => {
  assert.match(surface, /fetch\('\/surfaces\.json'/);
  assert.match(surface, /welcome = d && typeof d\.welcome === 'object'/);
  assert.match(surface, /content\.addEventListener\('click'/);
  assert.match(surface, /parent\.postMessage\(\{ t: 'open-agent', seat: b\.dataset\.seat \}/);
});

test("FLOOR defines every visual token used by the declared welcome", () => {
  const root = surface.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(root, /--text\s*:/, "positive control: the root token block was not read");

  for (const token of ["edge2", "body", "faint", "bone"]) {
    assert.match(root, new RegExp(`--${token}\\s*:`), `welcome token --${token} is undefined`);
  }
});

test("FLOOR keeps the all-rig caption and live-to-polling refresh path", () => {
  assert.match(surface, /rig\.textContent = state\.rig/);
  assert.match(surface, /new EventSource\('\/api\/events'\)/);
  assert.match(
    surface,
    /setTransport\('polling', 'polling fallback'\)/,
    "the polling fallback, through setTransport so a not-attached Floor keeps its label",
  );
  assert.match(surface, /setInterval\(refresh, 15000\)/);
});

// ---- the agent panel renders a configured-but-stopped member honestly -------
// The roster carries a per-seat `status`. The shell used to ignore it and render
// every row as the same enabled, attachable button, so a member that was down
// looked identical to one that was running until you clicked it.

const SHELL = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");

test("a non-running seat is rendered as unattachable rather than dropped", () => {
  assert.match(SHELL, /\.seatTile\.down/, "positive control: the down style was not found");
  assert.match(SHELL, /const live = running && attachable;/);
  assert.match(SHELL, /b\.disabled = !live/, "a stopped member is still clickable");
  assert.match(
    SHELL,
    /so there is no session to attach to/,
    "the tile does not say WHY it is unavailable",
  );
});

test("an absent status is treated as attachable, so a hand-declared roster is not greyed out", () => {
  // The over-correction to avoid: a consumer that declares {seat, name} rows by
  // hand supplies no status, and treating unknown as down would grey out every
  // seat on the honest path.
  assert.match(SHELL, /s\.status === undefined \|\| s\.status === "running"/);
});

test("the panel does not default its selection onto a seat it cannot attach to", () => {
  assert.match(
    SHELL,
    /const firstUp = seats\.find\(canAttach\)/,
    "selection still takes seats[0] blind, which lands on a stopped member",
  );
});

test("FLOOR counts a seat waiting on a person (attention_required) as needing attention, and colours it", () => {
  // OpenRig reports a seat at a login or prompt as attention_required. Counting only blocked/stalled/down showed
  // "0 need attention" beside two seats marked ATTENTION_REQUIRED.
  const line = surface.split("\n").find((l) => /const attention = /.test(l)) || "";
  assert.match(line, /'attention_required'/);
  assert.match(surface, /\.attention_required\b[^{]*\{|,\s*\.attention_required\s*\{/);
});

// ---- each floor state says one thing ----------------------------------------
// The page's own script, run against a stub DOM: no browser needed to read what each state puts on the screen.

function runFloor() {
  const el = () => ({
    textContent: "",
    innerHTML: "",
    className: "",
    lastElementChild: { textContent: "" },
    value: "",
    hidden: false,
    addEventListener() {},
    querySelectorAll: () => [],
  });
  const nodes = {
    "#content": el(),
    "#rig": el(),
    "#updated": el(),
    "#connection": el(),
    ".eyebrow": el(),
    "#find": el(),
    "#found": el(),
    "#findbox": el(),
  };
  const ctx = {
    document: { querySelector: (q) => nodes[q] },
    addEventListener() {},
    location: { hash: "" },
    URLSearchParams,
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    parent: { postMessage() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(surface.match(/<script>([\s\S]*)<\/script>/)[1], ctx);
  const shown = () => ({
    heading: nodes["#rig"].textContent,
    body: nodes["#content"].innerHTML
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    signal: nodes["#connection"].lastElementChild.textContent,
  });
  return { render: (state) => (ctx.render(state), shown()) };
}

test("FLOOR's detached and idle states each say one thing, and none contradicts another", () => {
  const floor = runFloor();
  const notAttached = floor.render({ ok: true, attached: false, reason: "no-rig" });
  assert.deepEqual(notAttached, {
    heading: "Not attached",
    body: "No rig is running on this box.",
    signal: "not attached",
  });

  const unreadable = floor.render({
    ok: true,
    attached: false,
    reason: "rig-error",
    detail: "rig ps exited 1",
  });
  assert.equal(unreadable.heading, "Rig unreadable");
  assert.equal(unreadable.body, "The rig is installed but could not be read. rig ps exited 1");
  assert.equal(unreadable.signal, "rig unreadable");
  for (const s of [notAttached, unreadable])
    assert.doesNotMatch(Object.values(s).join(" "), /idle/);

  const seat = {
    seat: "a@r",
    pod: "p",
    member: "a",
    state: "idle",
    lifecycle: "running",
    ageMinutes: 1,
    pendingWork: 0,
  };
  const idle = floor.render({
    ok: true,
    rig: "my-rig",
    seats: [seat],
    queue: [],
    generatedAt: new Date().toISOString(),
  });
  assert.equal(idle.heading, "my-rig");
  assert.match(idle.body, /^my-rig is idle: no seat is working and the queue is clear\./);
  assert.doesNotMatch(idle.body, /not attached|unreadable/i);

  const busy = floor.render({
    ok: true,
    rig: "my-rig",
    seats: [{ ...seat, state: "working" }],
    queue: [],
    generatedAt: new Date().toISOString(),
  });
  assert.doesNotMatch(busy.body, /is idle/, "control: a working rig isn't called idle");
});

// ---- the agents panel, run against a stub page ---------------------------------
function agentPanel(reg) {
  const m = SHELL.match(/\/\/ BEGIN AGENT SIDEBAR([\s\S]*?)\/\/ END AGENT SIDEBAR/);
  assert.ok(m, "the agent sidebar block is present");
  const el = (tag = "div") => {
    const e = {
      tagName: tag,
      innerHTML: "",
      textContent: "",
      className: "",
      title: "",
      disabled: false,
      dataset: {},
      style: {},
      children: [],
      classList: { add() {}, toggle() {} },
      appendChild: (c) => (e.children.push(c), c),
      cloneNode: () => el(tag),
      replaceWith() {},
    };
    Object.defineProperty(e, "innerHTML", {
      get: () => e._html ?? "",
      set: (v) => {
        e._html = v;
        if (v === "") e.children = [];
      },
    });
    return e;
  };
  const ids = {};
  for (const id of [
    "agents",
    "agents-body",
    "chatRigSel",
    "seatTiles",
    "seatName",
    "chatframe",
    "agentToggle",
  ])
    ids[id] = el();
  const ctx = {
    reg,
    document: { getElementById: (id) => ids[id], createElement: (t) => el(t) },
    localStorage: { getItem: () => null, setItem() {} },
    location: { origin: "http://127.0.0.1:8890" },
  };
  vm.createContext(ctx);
  vm.runInContext(`(() => {${m[1]}; globalThis.openAgents = openAgents; })()`, ctx);
  ctx.openAgents();
  const text = (h) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return {
    body: text(ids["agents-body"].innerHTML),
    tiles: ids.seatTiles.children.map((b) => ({
      name: b.textContent,
      mark: b.children[0]?.textContent ?? null,
      disabled: b.disabled,
    })),
  };
}

const rigRows = [
  { seat: "build-one@my-rig", name: "build.one", status: "running" },
  { seat: "build-two@my-rig", name: "build.two", status: "exited" },
];

test("agents panel: a rig's roster with no terminal says it came from the rig and lists every member, not attachable", () => {
  const p = agentPanel({ chatSeats: rigRows, chatSeatsFrom: "rig" });
  assert.match(p.body, /^2 seat\(s\) from rig my-rig, not attachable/);
  assert.doesNotMatch(p.body, /declared/);
  assert.deepEqual(p.tiles, [
    { name: "build.one", mark: "not attachable", disabled: true },
    { name: "build.two", mark: "exited", disabled: true },
  ]);
});

test("agents panel: a declared roster says declared; with a terminal, a running seat is attachable", () => {
  const declared = agentPanel({ chatSeats: [{ seat: "one@x", name: "one" }] });
  assert.match(declared.body, /^1 seat\(s\) declared by this Studio, not attachable/);
  assert.deepEqual(declared.tiles, [{ name: "one", mark: "not attachable", disabled: true }]);

  const live = agentPanel({ chatSeats: rigRows, chatSeatsFrom: "rig", chatLocalPort: 9999 });
  assert.equal(live.body, "");
  assert.deepEqual(live.tiles, [
    { name: "build.one", mark: null, disabled: false },
    { name: "build.two", mark: "exited", disabled: true },
  ]);
});

test("agents panel: no agents says why, by where the roster would have come from", () => {
  assert.match(
    agentPanel({ chatSeats: [], chatSeatsFrom: "none" }).body,
    /No rig is attached to this Studio/,
  );
  assert.match(
    agentPanel({ chatSeats: [], chatSeatsFrom: "declared" }).body,
    /declares an empty roster/,
  );
});
