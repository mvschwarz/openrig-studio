// The Floor's "Done recently": an artifact inside one of this Studio's Files folders (GET /api/files/roots) gets "Open in Files",
// by the same rule as Home's (inRoots, rootNames, placeOf in the apps' home view.js); anything else stays plain text, as before.
// The link carries the folder's name and the rest, never the box's absolute path. Run as the page runs: the surface's own script in
// a vm with just enough of a page.
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
const done = (artifact, id = "task-20261026100000-done") => ({
  id,
  state: "done",
  title: "Sales summary",
  source: "cus-pat-caller@acme-team",
  destination: "acme-lead@acme-team",
  closedAt: "2026-10-26T10:00:00.000Z",
  decision: { reason: "no-follow-on", target: null },
  result: "Wrote it",
  resultRead: true,
  resolution: null,
  artifact,
});
const STATE = (...rows) => ({
  ok: true,
  rig: "acme-team",
  generatedAt: "2026-10-26T10:01:00.000Z",
  attached: true,
  seats: [],
  queue: [],
  done: {
    rows,
    coverage: { looked: rows.length, ours: rows.length, shown: rows.length, limit: 100 },
  },
});
const ROOTS = { ok: true, roots: ["/home/pat/studio/media", "/home/pat/studio/work"] };

// roots: a body to answer /api/files/roots with, { status } for an HTTP answer without one, "hang" for no answer, "throw" for a
// network failure, "held" to answer later with calls.release(body). calls.stateFails makes the next state reads throw.
function page({ state, roots = ROOTS, framed = true }) {
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
  const calls = { roots: 0, posted: [], release: null, stateFails: false };
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
      if (url === "/api/factory/state")
        return calls.stateFails ? Promise.reject(new TypeError("Failed to fetch")) : answer(state);
      if (url === "/api/files/roots") {
        calls.roots++;
        if (roots === "hang") return new Promise(() => {});
        if (roots === "held")
          return new Promise((resolve) => {
            calls.release = (body) => resolve({ ok: true, status: 200, json: async () => body });
          });
        if (roots === "throw") return Promise.reject(new TypeError("Failed to fetch"));
        return roots.status
          ? answer({ ok: false, error: "no such contract route" }, roots.status)
          : answer(roots);
      }
      return answer({});
    },
    EventSource: function () {
      return { close() {}, addEventListener() {} };
    },
  };
  ctx.parent = framed ? { postMessage: (m, origin) => calls.posted.push({ m, origin }) } : ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  const html = () => els["#content"].innerHTML;
  // A click on the first "Open in Files" link, through the page's own delegated listener.
  const click = () => {
    const m =
      /<a class="files-open" href="([^"]*)" target="_top" data-surface="([^"]*)" data-hash="([^"]*)">/.exec(
        html(),
      );
    const a = {
      dataset: { surface: m[2], hash: m[3].replace(/&#39;/g, "'").replace(/&amp;/g, "&") },
    };
    let prevented = false;
    els["#content"].listeners.click({
      target: { closest: (sel) => (sel === "a[data-surface]" ? a : null) },
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  return { html, calls, click, ctx };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const link = (html) =>
  /<a class="files-open" href="([^"]*)" target="_top" data-surface="files" data-hash="([^"]*)">Open in Files<\/a>/.exec(
    html,
  );

test("CONTROL: an artifact inside a Files folder gets 'Open in Files' at its folder place, never the box's absolute path", async () => {
  const p = page({ state: STATE(done("/home/pat/studio/work/reports/sales-summary.csv")) });
  await settle();
  const m = link(p.html());
  assert.ok(m, p.html().slice(0, 400));
  const hash = "#open=" + encodeURIComponent("work/reports/sales-summary.csv");
  assert.equal(m[2], hash);
  assert.equal(m[1], "/?s=files&amp;h=" + encodeURIComponent(hash));
  assert.doesNotMatch(m[1] + m[2], /home|pat|studio%2F/, "no absolute path in the link");
  // The cell shows the place in Files (what Files shows when it opens), the full path only in the tooltip; the row is marked so a narrow screen gives the button its own line.
  const cell = /<td class="artifact">([\s\S]*?)<\/td>/.exec(p.html())[1];
  assert.match(
    cell,
    /^<span class="files-place" title="\/home\/pat\/studio\/work\/reports\/sales-summary\.csv">work\/<wbr>reports\/<wbr>sales-summary\.csv<\/span><span class="files-sep"> · <\/span><a class="files-open"/,
    cell,
  );
  assert.equal(
    cell.replace(/ title="[^"]*"/, "").includes("/home/"),
    false,
    "the box path only in the tooltip",
  );
  assert.match(p.html(), /<tr data-id="task-20261026100000-done" class="has-files">/);
});

test("outside the folders, relative, or climbing out with /../: the full path as plain text, as before; no file: 'No file recorded'", async () => {
  for (const a of [
    "/home/pat/elsewhere/x.csv",
    "work/x.csv",
    "/home/pat/studio/work/../../.ssh/id",
    "/home/pat/studio/workshop/x.csv",
    "/home/pat/studio/work/..",
  ]) {
    const p = page({ state: STATE(done(a)) });
    await settle();
    assert.equal(link(p.html()), null, a);
    const cell = /<td class="artifact">([\s\S]*?)<\/td>/.exec(p.html())[1];
    assert.equal(cell.replace(/<wbr>/g, "").replace(/&#39;/g, "'"), a, a);
    assert.match(p.html(), /<tr data-id="task-20261026100000-done">/, a);
  }
  const p = page({ state: STATE(done(null)) });
  await settle();
  assert.match(p.html(), /<td class="artifact"><span class="unset">No file recorded<\/span><\/td>/);
});

test("a Studio without Files (404), or an unreadable list: plain text, and the folders are asked once, not every refresh", async () => {
  for (const roots of [{ status: 404 }, { ok: false, error: "x" }, { ok: true, roots: "nope" }]) {
    const p = page({ state: STATE(done("/home/pat/studio/work/a.csv")), roots });
    await settle();
    assert.equal(link(p.html()), null, JSON.stringify(roots));
    p.ctx.render(STATE(done("/home/pat/studio/work/a.csv"))); // the next refresh
    await settle();
    assert.equal(p.calls.roots, 1, "settled by the first answer");
  }
});

test("folders that never answer hold nothing: the rows draw at once with plain text", async () => {
  const p = page({ state: STATE(done("/home/pat/studio/work/a.csv")), roots: "hang" });
  await settle();
  assert.match(p.html(), /Done recently · 1/);
  assert.equal(link(p.html()), null);
});

test("a network failure leaves the folders unknown, so the next refresh asks again", async () => {
  const p = page({ state: STATE(done("/home/pat/studio/work/a.csv")), roots: "throw" });
  await settle();
  assert.equal(link(p.html()), null);
  assert.equal(p.calls.roots, 1);
  p.ctx.render(STATE(done("/home/pat/studio/work/a.csv"))); // the next refresh
  await settle();
  assert.equal(p.calls.roots, 2, "asked again");
});

test("folders that share a name are told apart as Home does (name~1, name~2) and the deepest folder wins", async () => {
  const roots = { ok: true, roots: ["/a/work", "/b/work", "/b/work/inner"] };
  const cases = [
    ["/a/work/x.md", "work~1/x.md"],
    ["/b/work/y.md", "work~2/y.md"],
    ["/b/work/inner/z.md", "inner/z.md"],
  ];
  for (const [a, place] of cases) {
    const p = page({ state: STATE(done(a)), roots });
    await settle();
    assert.equal(link(p.html())?.[2], "#open=" + encodeURIComponent(place), a);
  }
});

test("a click asks the shell to switch to Files at that place (this origin only); with no shell, the link's own href does it", async () => {
  const p = page({ state: STATE(done("/home/pat/studio/media/clip.mp4")) });
  await settle();
  assert.equal(p.click(), true, "the shell switches in place");
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls.posted)), [
    {
      m: { t: "open-surface", id: "files", hash: "#open=" + encodeURIComponent("media/clip.mp4") },
      origin: "http://127.0.0.1:9320",
    },
  ]);
  const q = page({ state: STATE(done("/home/pat/studio/media/clip.mp4")), framed: false });
  await settle();
  assert.equal(q.click(), false, "not framed: the browser follows the href");
  assert.deepEqual(q.calls.posted, []);
});

// Folders that arrive late redraw only what is on screen now. A newer degraded, not-attached or
// unreadable answer drawn while they were on their way stays; the older work never comes back.
for (const [name, newer, says] of [
  [
    "a degraded answer",
    (p) => p.ctx.render({ ok: false, degraded: "provider timed out" }),
    /Data degraded: provider timed out/,
  ],
  [
    "a not-attached answer",
    (p) =>
      p.ctx.render({
        ok: true,
        rig: null,
        attached: false,
        reason: "no-rig",
        detail: null,
        seats: [],
        queue: [],
      }),
    /No rig is running on this box\./,
  ],
  [
    "a state read that fails",
    async (p) => {
      p.calls.stateFails = true;
      await p.ctx.refresh();
    },
    /Unable to read floor state: Failed to fetch/,
  ],
]) {
  test(`CONTROL: late folders after ${name} keep that on screen; the older finished work doesn't come back`, async () => {
    const p = page({ state: STATE(done("/home/pat/studio/work/a.csv")), roots: "held" });
    await settle();
    assert.match(p.html(), /Done recently · 1/, "the work was drawn first");
    await newer(p);
    assert.match(p.html(), says);
    p.calls.release(ROOTS);
    await settle();
    assert.match(p.html(), says, "still the newer answer");
    assert.doesNotMatch(p.html(), /Done recently|Open in Files/);
  });
}
test("late folders with the work still on screen add the link (the redraw that should happen)", async () => {
  const p = page({ state: STATE(done("/home/pat/studio/work/a.csv")), roots: "held" });
  await settle();
  assert.equal(link(p.html()), null);
  p.calls.release(ROOTS);
  await settle();
  assert.equal(link(p.html())?.[2], "#open=" + encodeURIComponent("work/a.csv"));
});
test("CONTROL: a Files folder mounted at '/' has no name, so its files stay plain text: never an absolute path in a link", async () => {
  for (const roots of [
    { ok: true, roots: ["/"] },
    { ok: true, roots: ["/", "/home/pat/studio/media"] },
  ]) {
    const p = page({ state: STATE(done("/home/pat/studio/work/a.csv")), roots });
    await settle();
    assert.equal(link(p.html()), null, JSON.stringify(roots));
    assert.doesNotMatch(p.html(), /%2Fhome|#open=\//, JSON.stringify(roots));
  }
  const q = page({
    state: STATE(done("/home/pat/studio/media/clip.mp4")),
    roots: { ok: true, roots: ["/", "/home/pat/studio/media"] },
  });
  await settle();
  assert.equal(
    link(q.html())?.[2],
    "#open=" + encodeURIComponent("media/clip.mp4"),
    "a named folder beside it still links",
  );
});
