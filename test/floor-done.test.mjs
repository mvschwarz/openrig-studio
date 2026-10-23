// FLOOR keeps finished work findable: the runtime carries the generator's optional `done` block in its declared shape
// (contract/runtime-api.md), and the surface shows it as "Done recently" with "not recorded" where a field is missing and a
// find-by-id box that looks only at what the floor already holds. Invented fixture data only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surface = fs.readFileSync(path.join(REPO, "app", "surfaces", "floor.html"), "utf8");
const DONE = { rows: [
  { id: "qitem-20261023070000-aaaa", state: "done", title: "Fix the README typo.", source: "assistant@lab", destination: "lab-impl@lab",
    closedAt: "2026-10-23T07:00:00.000Z", decision: { reason: "no-follow-on", target: null }, result: "Fixed <b>line 12</b>.", resultRead: true,
    resolution: null, artifact: "docs/README.md@1a2b3c4", handedOffTo: null, handedOffFrom: null },
  { id: "qitem-20261023065900-bbbb", state: "done", title: "Answer a question", source: "lab-qa@lab", destination: "lab-impl@lab",
    closedAt: "2026-10-23T06:59:00.000Z", decision: { reason: null, target: null }, result: null, resultRead: true, resolution: null, artifact: null },
  { id: "qitem-20261023065800-cccc", state: "done", title: "Unread", source: "lab-qa@lab", destination: "lab-impl@lab",
    closedAt: "2026-10-23T06:58:00.000Z", decision: { reason: "handed_off_to", target: "qitem-x" }, result: null, resultRead: false, artifact: null },
], coverage: { looked: 40, ours: 3, shown: 3, limit: 100 } };
const SEATS = [{ seat: "lab-impl@lab" }, { seat: "lab-qa@lab" }];
const OPEN = [{ id: "qitem-20261023071000-dddd", state: "pending", destination: "lab-impl@lab", source: "assistant@lab", tags: [], updated: "2026-10-23T07:10:00.000Z", title: "Open work" }];

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function stateFrom(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-done-"));
  fs.cpSync(path.join(REPO, "app"), path.join(dir, "app"), { recursive: true });
  fs.cpSync(path.join(REPO, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "fixtures", "factory-state.json"), JSON.stringify(fixture));
  const port = await freePort(), proc = spawn(process.execPath, [path.join(dir, "app", "serve-studio.mjs"), "--port", String(port), "--fixtures", path.join(dir, "fixtures")], { cwd: dir, stdio: "ignore" });
  try {
    for (let i = 0; i < 100; i++) { try { return await (await fetch(`http://127.0.0.1:${port}/api/factory/state`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
    throw new Error("runtime never answered");
  } finally { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test("the runtime carries `done` through in its declared shape; absent stays absent; a malformed one is carried as unreadable, never as none", async () => {
  const s = await stateFrom({ rig: "lab", attached: true, seats: [], queue: OPEN, done: DONE });
  assert.deepEqual(s.done, DONE); assert.deepEqual(s.queue, OPEN, "queue is unchanged");
  assert.equal("done" in await stateFrom({ rig: "lab", attached: true, seats: [], queue: [] }), false, "a generator that sends no done: absent, not empty");
  for (const bad of ["nope", { rows: [null] }, { rows: [{ title: "no id" }] }, { rows: "x" }, null]) {
    const s2 = await stateFrom({ rig: "lab", attached: true, seats: [], queue: OPEN, done: bad });
    assert.deepEqual(s2.done, { rows: [], coverage: { unreadable: "the finished work this box sent wasn't in the declared shape" } }, JSON.stringify(bad));
    assert.deepEqual(s2.queue, OPEN, "a bad finished-work block never costs the open work");
  }
  assert.deepEqual((await stateFrom({ rig: "lab", attached: true, seats: [], queue: [], done: { rows: [] } })).done, { rows: [], coverage: {} });
});

// The surface's own script, run with just enough of a page for render() and the find box.
function page() {
  const el = (sel) => ({ sel, innerHTML: "", textContent: "", value: "", className: "", lastElementChild: { textContent: "" }, hidden: false,
    addEventListener() {}, querySelectorAll() { return rowsOf(this.innerHTML); } });
  const els = { "#content": el("#content"), "#rig": el("#rig"), "#updated": el("#updated"), "#connection": el("#connection"), "#find": el("#find"), "#found": el("#found"), "#findbox": el("#findbox") };
  const rows = new Map();
  const rowsOf = (html) => [...html.matchAll(/<tr data-id="([^"]+)">/g)].map((m) => rows.get(m[1]) || rows.set(m[1], { dataset: { id: m[1] }, hidden: false }).get(m[1]));
  const ctx = { document: { querySelector: (s) => els[s] }, fetch: () => new Promise(() => {}), EventSource: function () {}, setInterval, clearInterval, setTimeout, clearTimeout, parent: { postMessage() {} }, console };
  vm.createContext(ctx);
  vm.runInContext(surface.match(/<script>([\s\S]*)<\/script>/)[1].replace(/\bboot\(\);\s*$/, ""), ctx);
  return { ctx, els, rowsOf };
}

test("FLOOR draws 'Done recently': id, decision, result (escaped), artifact; 'not recorded' and 'couldn't be read' are said; the open count is open work only", () => {
  const { ctx, els } = page();
  ctx.render({ ok: true, rig: "lab", generatedAt: "2026-10-23T07:11:00.000Z", attached: true, seats: SEATS, queue: OPEN, done: DONE });
  const h = els["#content"].innerHTML;
  assert.match(h, /<b>1<\/b><span>queue items<\/span>/, "finished work doesn't count as queued");
  assert.match(h, /<h2>Done recently · 3<\/h2>/);
  assert.match(h, /The newest 3 of this rig's finished work, from the newest 40 finished items on this box\./);
  assert.match(h, /<span class="item-id">qitem-20261023070000-aaaa<\/span>/);
  assert.match(h, /<td class="route">no-follow-on<\/td>/);
  assert.match(h, /<td class="result">Fixed &lt;b&gt;line 12&lt;\/b&gt;\.<\/td>/, "result text is escaped, never markup");
  assert.match(h, /<td class="route">docs\/README\.md@1a2b3c4<\/td>/);
  assert.equal((h.match(/<span class="unset">not recorded<\/span>/g) || []).length, 4, "row b: decision, result and artifact; row c: artifact only (its decision is recorded, its result couldn't be read)");
  assert.match(h, /<td class="result"><span class="unset">couldn't be read<\/span><\/td>/);
  assert.match(h, /handed_off_to → qitem-x/);
  ctx.render({ ok: true, rig: "lab", generatedAt: "x", attached: true, seats: [], queue: [] });
  assert.doesNotMatch(els["#content"].innerHTML, /Done recently/, "a provider that sends no done: no section");
  ctx.render({ ok: true, rig: "lab", generatedAt: "x", attached: true, seats: [], queue: [], done: { rows: [], coverage: { unreadable: "rig queue timed out" } } });
  assert.match(els["#content"].innerHTML, /Finished work couldn't be read: rig queue timed out\./);
});

test("find by id looks only at the floor's own rows: matches are kept, others hidden, and a miss says so plainly", () => {
  const { ctx, els, rowsOf } = page();
  ctx.render({ ok: true, rig: "lab", generatedAt: "x", attached: true, seats: SEATS, queue: OPEN, done: DONE });
  els["#find"].value = "aaaa"; ctx.findWork();
  const rows = rowsOf(els["#content"].innerHTML);
  assert.deepEqual(rows.filter((r) => !r.hidden).map((r) => r.dataset.id), ["qitem-20261023070000-aaaa"]);
  assert.equal(els["#found"].textContent, "0 open, 1 finished");
  els["#find"].value = "qitem-from-another-rig"; ctx.findWork();
  assert.equal(els["#found"].textContent, "No work with that id in this rig's open work or its newest 3 finished items (older finished work isn't searched).");
  assert.ok(rowsOf(els["#content"].innerHTML).every((r) => r.hidden));
  els["#find"].value = ""; ctx.findWork(); assert.equal(els["#found"].textContent, ""); assert.ok(rowsOf(els["#content"].innerHTML).every((r) => !r.hidden));
  assert.doesNotMatch(surface.slice(surface.indexOf("function findWork"), surface.indexOf("findInput.addEventListener")), /fetch\(/, "the find box reads nothing");
});

// Review fixes on the first candidate. Each fails on it.
test("find counts only this floor's work: another rig's open item a generator still sends is neither found nor shown", () => {
  const { ctx, els, rowsOf } = page();
  const foreign = { id: "qitem-20261023071100-ffff", state: "pending", destination: "y@other", source: "x@other", tags: [], updated: "x", title: "theirs" };
  ctx.render({ ok: true, rig: "lab", generatedAt: "x", attached: true, seats: SEATS, queue: [...OPEN, foreign], done: DONE });
  els["#find"].value = "ffff"; ctx.findWork();
  assert.match(els["#found"].textContent, /^No work with that id in this rig's open work/);
  assert.ok(rowsOf(els["#content"].innerHTML).every((r) => r.hidden));
  els["#find"].value = "dddd"; ctx.findWork(); assert.equal(els["#found"].textContent, "1 open, 0 finished");
});

test("bounded and unreadable finished work are said as such: no 'yet', and find doesn't claim a miss it can't know", () => {
  const { ctx, els } = page();
  ctx.render({ ok: true, rig: "lab", generatedAt: "x", attached: true, seats: SEATS, queue: OPEN, done: { rows: [], coverage: { looked: 100, ours: 0, shown: 0, limit: 100 } } });
  assert.match(els["#content"].innerHTML, /None of this rig's work among the newest 100 finished items on this box\./); assert.doesNotMatch(els["#content"].innerHTML, /yet/);
  ctx.render({ ok: true, rig: "lab", generatedAt: "x", attached: true, seats: SEATS, queue: OPEN, done: { rows: [], coverage: { unreadable: "rig queue timed out" } } });
  els["#find"].value = "qitem-anything"; ctx.findWork();
  assert.equal(els["#found"].textContent, "Not in this rig's open work. Finished work couldn't be read, so this can't say whether it finished.");
});

test("a hidden element stays hidden whatever a class says: the stylesheet makes [hidden] win", () => {
  assert.match(surface, /\[hidden\] \{ display: none !important; \}/);
  assert.match(surface, /\.find \{ display: flex;/, "the rule [hidden] has to beat is still there (positive control)");
  assert.match(surface, /<div class="find" id="findbox" role="search" hidden>/);
});
