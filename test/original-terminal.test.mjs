// The agents view's terminal next to an agent's chat follows the SELECTED original conversation (tools/herdr-tile.mjs): C1 before
// attach, C2 while attached (events + interval), C3 no cache, C4 a check before each Enter in Type. A stand-in OpenRig daemon
// (rigs, nodes, the conditional read, the events stream) and a stand-in Herdr record every call; no real daemon, Herdr or agent
// runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TILE = path.join(REPO, "tools", "herdr-tile.mjs");
const { selectionOf, splitOriginal, parseArgs, LINES } = await import(TILE);
const { AGENTS_WATCH, AGENTS_TYPE, routeArgs } = await import(
  path.join(REPO, "tools", "hosted-terminals.mjs")
);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = (t, p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// Test vectors for the selection hash, sha256 of JSON.stringify([nodeId, runtime, canonicalSessionName, resumeType, resumeToken]):
// one formula on both sides of the tile URL.
export const VECTORS = [
  [
    {
      nodeId: "01KZ0000000000000000NODE01",
      runtime: "claude-code",
      canonicalSessionName: "app-builder@acme",
      resumeType: "claude_id",
      resumeToken: "11111111-2222-3333-4444-555555555555",
    },
    "fec612737aa09091850d2238d4ba80ba6e9b4fb9949852b1073468b92e08a6ba",
  ],
  [
    {
      nodeId: "01KZ0000000000000000NODE02",
      runtime: "codex",
      canonicalSessionName: "app-checker@acme",
      resumeToken: "019a0000-0000-7000-8000-00000000c0de",
    }, // no resumeType: null
    "e0c8b76f850ac01622f1a4cb2d96ccaf97e0cf6edc1d6069fa599f365e61688b",
  ],
];
const T1 = "term_aa01",
  T2 = "term_aa02",
  N1 = VECTORS[0][0].nodeId,
  N2 = VECTORS[1][0].nodeId,
  A = "11111111-2222-3333-4444-555555555555",
  B = "bbbbbbbb-2222-3333-4444-555555555555";

// A stand-in daemon: rig r1 with N1 (app.builder, claude-code) and N2 (app.checker, codex). state.token is the node's resumeToken, what the
// roster says; state.native is what the seat actually holds now. C1 answers 200 only when the expected native id IS state.native.
async function fakeCore(t) {
  const state = {
    token: A,
    native: A,
    c1: "ok",
    calls: [],
    eventsReqs: [],
    streams: new Set(),
    seq: 100,
  };
  const node1 = () => ({
    ...VECTORS[0][0],
    logicalId: "app.builder",
    resumeToken: state.token,
    rigId: "r1",
  });
  const node2 = () => ({ ...VECTORS[1][0], logicalId: "app.checker", rigId: "r1" });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    state.calls.push({
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      auth: req.headers.authorization ?? null,
    });
    const send = (s, o) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === "/api/rigs") return send(200, [{ id: "r1", name: "acme" }]);
    if (u.pathname === "/api/rigs/r1/nodes") return send(200, [node1(), node2()]);
    const m = u.pathname.match(/^\/api\/sessions\/([^/]+)\/generation-record-expected$/);
    if (m) {
      if (state.c1 === "404") return send(404, { error: "not_found" });
      if (state.c1 === "400") return send(400, { error: "invalid_expected_identity" });
      if (state.c1 === "409") return send(409, { error: "expected_identity_unavailable" });
      if (state.c1 === "drop") {
        req.socket.destroy();
        return;
      }
      const want = {
        nodeId: u.searchParams.get("expectedNodeId"),
        sessionName: decodeURIComponent(m[1]),
        runtime: u.searchParams.get("expectedRuntime"),
        nativeId: u.searchParams.get("expectedNativeId"),
      };
      if (want.nativeId !== state.native) return send(409, { error: "expected_identity_mismatch" });
      return send(200, {
        generationId: "g1",
        sessionId: want.nativeId,
        runtime: want.runtime,
        totalBytes: 10,
        checkedIdentity: want,
        identityContract: 1,
      });
    }
    if (u.pathname === "/api/events") {
      state.eventsReqs.push({
        query: Object.fromEntries(u.searchParams),
        lastEventId: req.headers["last-event-id"] ?? null,
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": hi\n\n");
      state.streams.add(res);
      req.on("close", () => state.streams.delete(res));
      return;
    }
    send(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        for (const s of state.streams) s.destroy?.();
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  const emit = (e) => {
    const id = String(++state.seq);
    for (const s of state.streams)
      s.write(`id: ${id}\ndata: ${JSON.stringify({ seq: Number(id), ...e })}\n\n`);
    return id;
  };
  const endStreams = () => {
    for (const s of state.streams) s.end();
  };
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    emit,
    endStreams,
    c1Calls: () => state.calls.filter((c) => c.path.endsWith("/generation-record-expected")).length,
  };
}

// A stand-in Herdr: two labelled tmux-attach panes; observe prints a frame; attach records every byte it is given on stdin.
function fakeHerdr(t) {
  const d = scratch(t, "oth-"),
    bin = path.join(d, "herdr"),
    log = path.join(d, "calls.log"),
    input = path.join(d, "stdin.log");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs"), a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a[0] === "pane" && a[1] === "list") { out({ result: { panes: [{ pane_id: "p1", terminal_id: "${T1}", label: "app.builder" }, { pane_id: "p2", terminal_id: "${T2}", label: "app.checker" }] } }); process.exit(0); }
if (a[0] === "pane" && a[1] === "process-info") { out({ result: { process_info: { foreground_processes: [{ argv: ["tmux", "attach", "-t", "x"] }] } } }); process.exit(0); }
if (a[0] === "terminal" && a[1] === "session" && a[2] === "observe") { out({ type: "terminal.frame", bytes: Buffer.from("OBSERVED " + a[3] + "\\r\\n").toString("base64") }); setInterval(() => {}, 1000); }
if (a[0] === "terminal" && a[1] === "attach") { process.stdout.write("ATTACHED " + a.slice(2).join(" ") + "\\r\\n"); process.stdin.on("data", (b) => fs.appendFileSync(${JSON.stringify(input)}, b)); setInterval(() => {}, 1000); }
`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    typed: () => (fs.existsSync(input) ? fs.readFileSync(input, "utf8") : ""),
    attached: function () {
      return this.calls().filter((c) => c[0] === "terminal");
    },
  };
}

function tile(t, args, env) {
  const p = spawn(process.execPath, [TILE, ...args], {
    env: { PATH: "/usr/bin:/bin", STUDIO_ORIGINAL_RECHECK_MS: "1000", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => {
    out += d;
  });
  p.stderr.on("data", () => {});
  const exited = new Promise((r) => p.on("exit", r));
  t.after(() => {
    if (p.exitCode === null) p.kill("SIGKILL");
  });
  const ends = (ms = 4000) =>
    Promise.race([
      exited.then(() => true),
      settle(ms).then(() => {
        p.kill("SIGKILL");
        return false;
      }),
    ]);
  return {
    p,
    out: () => out,
    exited,
    ends,
    write: (s) => p.stdin.write(s),
    until: async (re, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(out)) return true;
        await settle(50);
      }
      return false;
    },
  };
}
const SEL = (conversation = VECTORS[0][1]) => ["--node", N1, "--conversation", conversation];

test("the selection hash: the two vectors the formula gives", () => {
  for (const [node, want] of VECTORS) assert.equal(selectionOf(node), want);
});

test("CONTROL, the arguments: legacy shapes unchanged; the selection pair both-or-neither, never with a view; hosted-terminals.mjs gives ttyd only these", () => {
  assert.deepEqual(parseArgs(["watch", T1]), {
    route: "watch",
    id: T1,
    mode: "watch",
    view: null,
    original: null,
  });
  assert.deepEqual(parseArgs(["type", T1, "type", ...SEL()]), {
    route: "type",
    id: T1,
    mode: "type",
    view: null,
    original: { node: N1, conversation: VECTORS[0][1] },
  });
  for (const bad of [
    ["watch", T1, "--node", N1],
    ["watch", T1, "--conversation", VECTORS[0][1]],
    ["watch", T1, "--conversation", VECTORS[0][1], "--node", N1],
    ["watch", T1, "--node", "bad id", "--conversation", VECTORS[0][1]],
    ["watch", T1, "--node", N1, "--conversation", "XYZ"],
    ["watch", "qitem:q1", T1, ...SEL()],
    ["watch", ...SEL(), T1],
  ])
    assert.equal(parseArgs(bad), null, JSON.stringify(bad));
  assert.equal(splitOriginal([T1]).original, null);
  const q = (r, a) =>
    routeArgs(r, `/agents/x/ws?${a.map((v) => "arg=" + encodeURIComponent(v)).join("&")}`);
  assert.deepEqual(q(AGENTS_TYPE, [T1, "type", ...SEL()])?.pass, [T1, "type", ...SEL()]);
  assert.deepEqual(q(AGENTS_WATCH, [T1])?.pass, [T1], "legacy unchanged");
  for (const bad of [
    [T1, "--node", N1],
    ["qitem:q1", T1, ...SEL()],
    [T1, ...SEL(), "x"],
  ])
    assert.equal(q(AGENTS_WATCH, bad), null, JSON.stringify(bad));
});

test("CONTROL C1, before attach: the selection still current and Core's check 200 -> attaches; A became B, or another seat's terminal -> one line, nothing attached", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t),
    env = { STUDIO_HERDR_BIN: h.bin, STUDIO_AGENTS_DAEMON: core.url };
  const ok = tile(t, ["watch", T1, ...SEL()], env);
  assert.ok(await ok.until(/OBSERVED term_aa01/), ok.out());
  assert.equal(core.c1Calls(), 1);
  const c1 = core.state.calls.find((c) => c.path.endsWith("/generation-record-expected"));
  assert.deepEqual(
    c1.query,
    { expectedNodeId: N1, expectedRuntime: "claude-code", expectedNativeId: A },
    "no sinceBytes; the server-side tuple",
  );
  ok.p.kill("SIGHUP");
  await ok.exited;
  const n = h.attached().length;
  // A -> B in the roster (the selection hash no longer matches): refused before Core's read.
  core.state.token = B;
  core.state.native = B;
  const b1 = tile(t, ["watch", T1, ...SEL()], env);
  assert.ok(await b1.ends(), "refused and ended, not attached: " + b1.out());
  assert.equal(b1.out(), LINES.notConfirmed + "\r\n");
  // The roster still says A but the seat holds B: Core's check refuses (409).
  core.state.token = A;
  const b2 = tile(t, ["type", T1, "type", ...SEL()], env);
  assert.ok(await b2.ends(), "refused and ended, not attached: " + b2.out());
  assert.equal(b2.out(), LINES.notConfirmed + "\r\n");
  // Checking A and attaching another seat's terminal can't pass: app.checker's T2 with app.builder's selection.
  core.state.native = A;
  const b3 = tile(t, ["watch", T2, ...SEL()], env);
  assert.ok(await b3.ends(), "refused and ended, not attached: " + b3.out());
  assert.equal(b3.out(), LINES.notConfirmed + "\r\n");
  assert.equal(h.attached().length, n, "nothing attached after a refusal");
});

test("CONTROL C1, every other answer keeps it chat-only: 404 (an older Core), 409, 400, no answer, no daemon configured", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t);
  for (const mode of ["404", "409", "400", "drop"]) {
    core.state.c1 = mode;
    const x = tile(t, ["watch", T1, ...SEL()], {
      STUDIO_HERDR_BIN: h.bin,
      STUDIO_AGENTS_DAEMON: core.url,
    });
    assert.ok(await x.ends(), mode + " ended: " + x.out());
    assert.equal(x.out(), LINES.notConfirmed + "\r\n", mode);
  }
  const down = tile(t, ["watch", T1, ...SEL()], {
    STUDIO_HERDR_BIN: h.bin,
    STUDIO_AGENTS_DAEMON: "http://127.0.0.1:9",
  });
  assert.ok(await down.ends());
  assert.equal(down.out(), LINES.notConfirmed + "\r\n", "no answer");
  const none = tile(t, ["watch", T1, ...SEL()], { STUDIO_HERDR_BIN: h.bin });
  assert.ok(await none.ends());
  assert.equal(none.out(), LINES.notConfirmed + "\r\n", "no daemon");
  assert.deepEqual(h.attached(), []);
});

test("CONTROL C2, while attached: Core's event for THIS node ends the terminal at once; another node's event doesn't", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t);
  const x = tile(t, ["watch", T1, ...SEL()], {
    STUDIO_HERDR_BIN: h.bin,
    STUDIO_AGENTS_DAEMON: core.url,
    STUDIO_ORIGINAL_RECHECK_MS: "60000",
  });
  assert.ok(await x.until(/OBSERVED/));
  await settle(300);
  assert.equal(core.state.eventsReqs.at(-1).query.replay, "0", "from now on, never the whole log");
  core.emit({ type: "seat.fresh_launched", nodeId: N2 });
  await settle(500);
  assert.equal(x.p.exitCode, null, "another node's event: still attached");
  core.state.token = B;
  core.state.native = B;
  core.emit({ type: "seat.fresh_launched", nodeId: N1 });
  assert.ok(
    await x.until(new RegExp(LINES.conversationChanged.replace(/[.;]/g, "\\$&")), 3000),
    x.out(),
  );
  await x.exited;
});

test("CONTROL C2, a lost stream is a recheck at once, then resumed with Last-Event-ID (no interval in play)", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t);
  const x = tile(t, ["watch", T1, ...SEL()], {
    STUDIO_HERDR_BIN: h.bin,
    STUDIO_AGENTS_DAEMON: core.url,
    STUDIO_ORIGINAL_RECHECK_MS: "60000",
  });
  assert.ok(await x.until(/OBSERVED/));
  await settle(300);
  const id = core.emit({ type: "rig.updated", rigId: "r1" }); // not a trigger: only its id is kept
  await settle(200);
  const before = core.c1Calls();
  core.endStreams();
  for (let i = 0; i < 40 && core.state.eventsReqs.length < 2; i++) await settle(100);
  assert.equal(core.c1Calls(), before + 1, "the end of the stream was one recheck");
  assert.equal(core.state.eventsReqs.at(-1).lastEventId, id, "reconnected with Last-Event-ID");
  assert.equal(core.state.eventsReqs.at(-1).query.replay, "0");
  core.state.native = B;
  core.endStreams(); // a change, then the stream drops: that recheck ends it
  assert.ok(await x.until(/conversation changed/, 3000), x.out());
  await x.exited;
});

test("CONTROL C2, a change that sends no event is caught by the interval, which runs in seconds, not a tight loop", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t);
  const x = tile(t, ["watch", T1, ...SEL()], {
    STUDIO_HERDR_BIN: h.bin,
    STUDIO_AGENTS_DAEMON: core.url,
    STUDIO_ORIGINAL_RECHECK_MS: "1000",
  });
  assert.ok(await x.until(/OBSERVED/));
  const before = core.c1Calls();
  await settle(2600);
  const ticks = core.c1Calls() - before;
  assert.ok(ticks >= 2 && ticks <= 3, `about one recheck a second (${ticks} in 2.6 s)`);
  core.state.native = B; // a change Core sends no event for: the interval finds it
  assert.ok(await x.until(/conversation changed/, 3000), x.out());
  await x.exited;
});

test("CONTROL C4, Type: input passes through, an Enter waits for Core's check, one check per chunk (a paste is one), and after a change the Enter is never sent", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t);
  const x = tile(t, ["type", T1, "type", ...SEL()], {
    STUDIO_HERDR_BIN: h.bin,
    STUDIO_AGENTS_DAEMON: core.url,
    STUDIO_ORIGINAL_RECHECK_MS: "60000",
  });
  assert.ok(await x.until(/ATTACHED term_aa01/));
  const c0 = core.c1Calls();
  x.write("abc");
  await settle(300);
  assert.equal(h.typed(), "abc", "no Enter: forwarded, no check");
  assert.equal(core.c1Calls(), c0);
  x.write("ok\r");
  await settle(400);
  assert.equal(h.typed(), "abcok\r");
  assert.equal(core.c1Calls(), c0 + 1, "one check for that Enter");
  x.write("one\rtwo\rthree\r");
  await settle(400);
  assert.equal(core.c1Calls(), c0 + 2, "a paste with three Enters is one chunk, one check");
  assert.equal(h.typed(), "abcok\rone\rtwo\rthree\r");
  core.state.native = B;
  x.write("rm -rf x\r");
  assert.ok(await x.until(/conversation changed/, 3000), x.out());
  await x.exited;
  assert.ok(!h.typed().includes("rm -rf x"), "the Enter after the change was never sent");
});

test("CONTROL C3 + legacy: every new wrapper checks again (nothing cached); a tile without the selection asks Core nothing, as before", async (t) => {
  const core = await fakeCore(t),
    h = fakeHerdr(t),
    env = { STUDIO_HERDR_BIN: h.bin, STUDIO_AGENTS_DAEMON: core.url };
  for (let i = 0; i < 2; i++) {
    const x = tile(t, ["watch", T1, ...SEL()], env);
    assert.ok(await x.until(/OBSERVED/));
    x.p.kill("SIGHUP");
    await x.exited;
  }
  assert.equal(core.c1Calls(), 2, "one check per wrapper");
  const n = core.state.calls.length;
  const legacy = tile(t, ["watch", T1], env);
  assert.ok(await legacy.until(/OBSERVED term_aa01/));
  legacy.p.kill("SIGHUP");
  await legacy.exited;
  const typ = tile(t, ["type", T1, "type"], env);
  assert.ok(await typ.until(/ATTACHED/));
  typ.write("hi\r");
  await settle(300);
  typ.p.kill("SIGHUP");
  await typ.exited;
  assert.equal(core.state.calls.length, n, "no Core call for a tile without the selection");
  assert.ok(h.typed().includes("hi\r"), "legacy Type still reaches Herdr (inherited stdin there)");
});
