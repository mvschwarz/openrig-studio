// The agents view's wrapper (tools/herdr-tile.mjs), run as ttyd -a would run it: its arguments are checked before Herdr is asked
// anything, membership is read fresh from Herdr's own list (or, with a task view, from the box's OpenRig daemon), and a tile's end
// is read from Herdr's own reason. Herdr and the daemon are stand-ins that record every call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TILE = path.join(REPO, "tools", "herdr-tile.mjs");
const { agentTerminals } = await import(TILE);
const scratch = (t, p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const T1 = "term_65ec4de94ab672",
  T2 = "term_65ec4de94c37a4",
  DASH = "term_65ec4de94cfbe5",
  SHPANE = "term_65ec4de94b6aa3",
  NOSEAT = "term_65ec4de94d1e07",
  DUP = "term_65ec4de94e5f10";
const PANES = [
  { pane_id: "w1:p2", terminal_id: T1, label: "app.builder" },
  { pane_id: "w1:p4", terminal_id: T2, label: "app.checker" },
  { pane_id: "w1:p3", terminal_id: SHPANE, label: "ops.lead" }, // labelled, but a shell
  { pane_id: "w1:p5", terminal_id: DASH }, // the dashboard: no label
  { pane_id: "w1:p6", terminal_id: NOSEAT, label: "Scratch Pane" }, // a tmux attach, not labelled as a seat
];
// Herdr on Linux sends no argv0; one pane keeps it, with a full path in argv[0], so both shapes are covered.
const LINUX_FG = (s) => ({
  argv: ["tmux", "attach", "-f", "ignore-size", "-t", `=${s}:`],
  name: "tmux: client",
  pid: 4242,
});
const FG = {
  "w1:p2": [{ argv0: "tmux", argv: ["/opt/homebrew/bin/tmux", "attach", "-t", "$0"] }],
  "w1:p4": [LINUX_FG("app-checker@acme-team")],
  "w1:p3": [{ argv0: "sh", argv: ["sh"] }],
  "w1:p5": [{ argv0: "sh", argv: ["sh"] }],
  "w1:p6": [LINUX_FG("scratch@acme-team")],
};
const RESTARTED = (id) => id.replace(/^term_65ec/, "term_77aa");
function panesFor(mode) {
  const panes = structuredClone(PANES);
  if (mode === "restarted") for (const p of panes) p.terminal_id = RESTARTED(p.terminal_id);
  if (mode === "dup") panes.push({ pane_id: "w2:p1", terminal_id: DUP, label: "app.builder" });
  return panes;
}
// A stand-in Herdr that answers as Herdr does: ends reported in-band or on stderr, the exit code often 0.
function fakeHerdr(t, { mode = "ok", panes } = {}) {
  const d = scratch(t, "herdr-"),
    bin = path.join(d, "herdr"),
    log = path.join(d, "calls.log"),
    stdin = path.join(d, "stdin.log");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("fs"), a = process.argv.slice(2), mode = ${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (a[0] === "pane" && a[1] === "list") { if (mode === "list-fails") { process.stderr.write("no server"); process.exit(1); } out({ result: { panes: ${JSON.stringify(panes ?? panesFor(mode))} } }); process.exit(0); }
if (a[0] === "pane" && a[1] === "process-info" && mode === "no-fg") { out({ result: { process_info: {} } }); process.exit(0); }
if (a[0] === "pane" && a[1] === "process-info" && mode === "null-fg") { out({ result: { process_info: { foreground_processes: null } } }); process.exit(0); }
if (a[0] === "pane" && a[1] === "process-info" && mode === "empty-fg") { out({ result: { process_info: { foreground_processes: [] } } }); process.exit(0); }
if (a[0] === "pane" && a[1] === "process-info") { out({ result: { process_info: { foreground_processes: (${JSON.stringify({ ...FG, "w2:p1": FG["w1:p2"] })})[a[3]] || [{ argv: ["tmux", "attach"] }] } } }); process.exit(0); }
process.stdin.on("data", (b) => fs.appendFileSync(${JSON.stringify(stdin)}, b));
const refusal = "terminal attach failed: terminal " + a[2] + " already has an attached client; retry with --takeover";
if (a[0] === "terminal" && a[1] === "attach") {
  if (mode === "in-use" && !a.includes("--takeover")) { process.stderr.write("herdr: server shut down: " + refusal + "\\n"); process.exit(1); }
  if (mode === "in-use-exit-0" && !a.includes("--takeover")) { process.stderr.write(refusal + "\\n"); process.exit(0); }
  process.stdout.write("ATTACHED " + a.slice(2).join(" ") + "\\r\\n");
  if (mode === "taken-over") setTimeout(() => { process.stderr.write("terminal attach taken over\\n"); process.exit(0); }, 300);
  else if (mode === "ends") setTimeout(() => process.exit(0), 300);
  else setInterval(() => {}, 1000);
}
if (a[0] === "terminal" && a[1] === "session" && a[2] === "observe") {
  if (mode === "stale") { out({ type: "terminal.closed", reason: "terminal session observe failed: terminal target " + a[3] + " not found" }); process.exit(0); }
  out({ type: "terminal.frame", bytes: Buffer.from("OBSERVED " + a[3] + "\\r\\n").toString("base64") });
  if (mode === "ends") setTimeout(() => process.exit(0), 300); else setInterval(() => {}, 1000);
}
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
    stdin: () => (fs.existsSync(stdin) ? fs.readFileSync(stdin, "utf8") : ""),
  };
}
const tile = (args, env, cwd) => {
  const r = spawnSync(process.execPath, [TILE, ...args], {
    cwd,
    env: { PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
    timeout: 5000,
  });
  return { out: r.stdout, code: r.status };
};
// A long-running tile, hung up once it has written what the test expects (a string, or a RegExp) (as ttyd does when the browser goes), or when it exits
// on its own. It waits on those events, never on a fixed clock: a loaded machine once made 3 s too short. After a match it
// listens a moment longer, so output that shouldn't be there still fails the test; the cap only ends a tile that hangs.
const run = (args, env, expect, input = null, cap = 30_000) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [TILE, ...args], { env: { PATH: "/usr/bin:/bin", ...env } });
    let out = "",
      grace = null;
    const done = () => {
      clearTimeout(k);
      clearTimeout(grace);
      p.kill("SIGHUP");
      resolve(out);
    };
    p.stdout.on("data", (d) => {
      out += d;
      const hit = expect instanceof RegExp ? expect.test(out) : out === expect;
      if (hit && !grace) grace = setTimeout(done, 150);
      else if (grace && !hit) done();
    });
    if (input) p.stdin.write(input);
    const k = setTimeout(done, cap);
    p.on("exit", done);
  });
const LINE = {
  shape: "This isn't one of this workspace's agent terminals.",
  setup: "The agents view isn't set up on this workspace yet.",
  gone: "This agent's terminal isn't open in this workspace now.",
  unreadable: "The agents in this workspace couldn't be read just now. Try again in a moment.",
  inUse:
    "In use elsewhere: this agent's terminal is open in another window. Watch it, or Take over.",
  takenOver: "Taken over in another window. Watch it, or Take over.",
  changed: "This terminal changed; reloading.",
  ended: "This agent's terminal has ended.",
  ambiguous:
    "Two terminals have this agent's name, so neither is shown. Ask your team to tell them apart.",
  readOnly: "This viewer is read-only, so it can only be watched.",
  noTaskViews: "This workspace's OpenRig doesn't have task views yet.",
};

test("arguments that aren't exactly the route's shape get one plain line before Herdr is asked anything", (t) => {
  const h = fakeHerdr(t);
  for (const args of [
    ["watch"],
    ["watch", T1, "type"],
    ["watch", "../etc/passwd"],
    ["watch", "term_ABC"],
    ["watch", `${T1};rm -rf /`],
    ["type", T1],
    ["type", T1, "watch"],
    ["type", T1, "type", "x"],
    ["type", T1, "--takeover"],
    ["takeover", T1],
    [],
  ]) {
    const r = tile(args, { STUDIO_HERDR_BIN: h.bin });
    assert.equal(r.out, LINE.shape + "\r\n", JSON.stringify(args));
    assert.notEqual(r.code, 0, JSON.stringify(args));
  }
  assert.deepEqual(h.calls(), [], "Herdr never ran");
});

test("Herdr that isn't a fixed absolute executable: one line, nothing run", (t) => {
  const h = fakeHerdr(t);
  for (const v of [
    undefined,
    "herdr",
    "./herdr",
    path.dirname(h.bin) + "/./herdr",
    h.bin + "/../herdr",
    "/nonexistent/herdr",
    path.dirname(h.bin),
  ]) {
    const r = tile(
      ["watch", T1],
      v === undefined ? {} : { STUDIO_HERDR_BIN: v },
      path.dirname(h.bin),
    );
    assert.equal(r.out, LINE.setup + "\r\n", String(v));
  }
  assert.deepEqual(h.calls(), []);
});

test("membership: the dashboard, a labelled shell, an unlabelled attach or an unknown id are refused after the list, before any attach", (t) => {
  const h = fakeHerdr(t);
  for (const id of [DASH, SHPANE, NOSEAT, "term_0123456789abcd"])
    assert.equal(
      tile(["type", id, "type"], { STUDIO_HERDR_BIN: h.bin }).out,
      LINE.gone + "\r\n",
      id,
    );
  assert.ok(h.calls().every((c) => c[0] === "pane"));
});

test("membership reads the program from argv0, else argv[0]'s basename, never from name; argv[1] must be attach", async (t) => {
  const bin = (fg) => {
    const b = path.join(scratch(t, "herdr-fg-"), "herdr");
    fs.writeFileSync(
      b,
      `#!${process.execPath}\nconst a = process.argv.slice(2), o = (x) => process.stdout.write(JSON.stringify(x) + "\\n");\nif (a[1] === "list") o({ result: { panes: [{ pane_id: "p1", terminal_id: "${T1}", label: "app.builder" }] } }); else o({ result: { process_info: { foreground_processes: ${JSON.stringify(fg)} } } });\n`,
      { mode: 0o755 },
    );
    return b;
  };
  const of = async (fg) => (await agentTerminals(bin(fg))).terminals.map((x) => x.terminal_id);
  assert.deepEqual(await of([LINUX_FG("app-builder@acme-team")]), [T1], "no argv0");
  assert.deepEqual(await of([{ argv0: "tmux", argv: ["tmux", "attach"] }]), [T1]);
  assert.deepEqual(await of([{ argv: ["/usr/bin/tmux", "attach", "-t", "x"] }]), [T1]);
  assert.deepEqual(
    await of([{ argv: ["bash"], name: "tmux: client" }]),
    [],
    "name alone never counts",
  );
  assert.deepEqual(await of([{ argv: ["tmux", "new-session"] }]), []);
  assert.deepEqual(await of([{ argv: ["/tmp/tmuxx", "attach"] }]), []);
  assert.deepEqual(
    await of([{ argv0: "bash", argv: ["tmux", "attach"] }]),
    [],
    "argv0 is the program",
  );
});

test("after a Herdr restart an old id is refused before any attach; the list is read fresh each time; the new id works", (t) => {
  const h = fakeHerdr(t, { mode: "restarted" });
  for (const args of [
    ["watch", T1],
    ["type", T1, "type"],
    ["type", T2, "takeover"],
  ])
    assert.equal(
      tile(args, { STUDIO_HERDR_BIN: h.bin }).out,
      LINE.gone + "\r\n",
      JSON.stringify(args),
    );
  assert.ok(h.calls().every((c) => c[0] === "pane"));
  assert.equal(h.calls().filter((c) => c[1] === "list").length, 3);
  const r = spawnSync(process.execPath, [TILE, "watch", RESTARTED(T1)], {
    env: { PATH: "/usr/bin:/bin", STUDIO_HERDR_BIN: h.bin },
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(r.stdout, `OBSERVED ${RESTARTED(T1)}\r\n`);
});

test("a seat label two panes share is ambiguous: both refused, neither picked; unreadable is said, never 'not an agent'", (t) => {
  const dup = fakeHerdr(t, { mode: "dup" });
  for (const args of [
    ["type", T1, "type"],
    ["watch", DUP],
  ])
    assert.equal(tile(args, { STUDIO_HERDR_BIN: dup.bin }).out, LINE.ambiguous + "\r\n");
  assert.ok(dup.calls().every((c) => c[0] === "pane"));
  for (const mode of ["list-fails", "no-fg", "null-fg"]) {
    const h = fakeHerdr(t, { mode });
    assert.equal(
      tile(["watch", T1], { STUDIO_HERDR_BIN: h.bin }).out,
      LINE.unreadable + "\r\n",
      mode,
    );
  }
  const empty = fakeHerdr(t, { mode: "empty-fg" });
  assert.equal(tile(["watch", T1], { STUDIO_HERDR_BIN: empty.bin }).out, LINE.gone + "\r\n");
});

test("type attaches without --takeover, takeover passes it; ends are read from Herdr's reason, never its exit code", async (t) => {
  const h = fakeHerdr(t);
  assert.match(
    await run(
      ["type", T1, "type"],
      { STUDIO_HERDR_BIN: h.bin },
      new RegExp(`ATTACHED ${T1}\\r\\n`),
    ),
    new RegExp(`ATTACHED ${T1}\\r\\n`),
  );
  assert.match(
    await run(
      ["type", T2, "takeover"],
      { STUDIO_HERDR_BIN: h.bin },
      new RegExp(`ATTACHED ${T2} --takeover`),
    ),
    new RegExp(`ATTACHED ${T2} --takeover`),
  );
  assert.deepEqual(
    h.calls().filter((c) => c[1] === "attach"),
    [
      ["terminal", "attach", T1],
      ["terminal", "attach", T2, "--takeover"],
    ],
  );
  const bin = (mode) => ({ STUDIO_HERDR_BIN: fakeHerdr(t, { mode }).bin });
  assert.equal(
    await run(["type", T1, "type"], bin("in-use"), LINE.inUse + "\r\n"),
    LINE.inUse + "\r\n",
  );
  assert.equal(
    await run(["type", T1, "type"], bin("in-use-exit-0"), LINE.inUse + "\r\n"),
    LINE.inUse + "\r\n",
  );
  assert.equal(
    await run(
      ["type", T1, "type"],
      bin("taken-over"),
      `ATTACHED ${T1}\r\n` + LINE.takenOver + "\r\n",
    ),
    `ATTACHED ${T1}\r\n` + LINE.takenOver + "\r\n",
  );
  assert.equal(
    await run(["watch", T1], bin("stale"), LINE.changed + "\r\n"),
    LINE.changed + "\r\n",
  );
  assert.equal(
    await run(["watch", T1], bin("ends"), `OBSERVED ${T1}\r\n` + LINE.ended + "\r\n"),
    `OBSERVED ${T1}\r\n` + LINE.ended + "\r\n",
  );
});

test("watch observes and writes the decoded bytes; nothing it is given on input reaches Herdr", async (t) => {
  const h = fakeHerdr(t);
  const out = await run(
    ["watch", T1],
    { STUDIO_HERDR_BIN: h.bin },
    `OBSERVED ${T1}\r\n`,
    "typed-on-a-watch-tile\r",
  );
  assert.equal(out, `OBSERVED ${T1}\r\n`);
  assert.deepEqual(
    h.calls().filter((c) => c[0] === "terminal"),
    [["terminal", "session", "observe", T1]],
  );
  assert.equal(h.stdin(), "");
});

// ---- with a task view: the daemon's VERIFIED viewer, never a label ----
const VIEW = "qitem:fix-login-task",
  T3 = "term_aa03",
  TL = "term_aa04";
const member = (nodeId, seat, viewerStatus, viewer) => ({
  key: { hostId: "h1", nodeId },
  seat,
  availability: "available",
  viewerStatus,
  ...(viewer ? { viewer } : {}),
});
const PREVIEW = (first = { terminalId: T1, readOnly: false }) => ({
  planId: "a".repeat(64),
  viewDescriptor: null,
  task: {
    qitemId: "fix-login-task",
    name: "Fix the login",
    members: [
      member("n1", "app-builder@acme-team", "verified", first),
      member("n2", "app-checker@acme-team", "unconfirmed", { terminalId: T2, readOnly: false }),
      member("n5", "app-writer@acme-team", "verified", { terminalId: T3, readOnly: true }),
    ],
  },
});
async function fakeDaemon(t, { old = false, preview = PREVIEW() } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    const send = (s, o) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/terminal/preview")
      return old
        ? send(404, {
            code: "view_not_found",
            error: `unknown view '${u.searchParams.get("view")}' — not a known rig, a mission:/slice: scope, or a saved-view id`,
          })
        : send(200, preview);
    send(404, { code: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    opened: () => calls.filter((c) => c.includes("/open")),
  };
}
const VIEW_PANES = [
  { pane_id: "p1", terminal_id: T1, label: "openrig-viewer-1" },
  { pane_id: "p2", terminal_id: T2, label: "openrig-viewer-2" },
  { pane_id: "p5", terminal_id: T3, label: "openrig-viewer-5" },
  { pane_id: "p9", terminal_id: TL, label: "app.builder" }, // a seat-labelled tile
];

test("with a task view only the daemon's verified viewer is shown; unconfirmed, label-matched, gone, read-only Type and an old daemon are refused", async (t) => {
  const daemon = await fakeDaemon(t),
    h = fakeHerdr(t, { panes: VIEW_PANES });
  const env = { STUDIO_HERDR_BIN: h.bin, STUDIO_AGENTS_DAEMON: daemon.url };
  assert.equal(await run(["watch", VIEW, T1], env, `OBSERVED ${T1}\r\n`), `OBSERVED ${T1}\r\n`);
  assert.equal(
    await run(["watch", VIEW, T2], env, LINE.gone + "\r\n"),
    LINE.gone + "\r\n",
    "unconfirmed",
  );
  assert.equal(
    await run(["watch", VIEW, TL], env, LINE.gone + "\r\n"),
    LINE.gone + "\r\n",
    "a label is not membership here",
  );
  assert.equal(
    await run(["type", VIEW, T3, "type"], env, LINE.readOnly + "\r\n"),
    LINE.readOnly + "\r\n",
  );
  assert.equal(await run(["watch", VIEW, T3], env, `OBSERVED ${T3}\r\n`), `OBSERVED ${T3}\r\n`);
  assert.equal(
    await run(["type", VIEW, T1, "type"], env, `ATTACHED ${T1}\r\n`),
    `ATTACHED ${T1}\r\n`,
  );
  const restarted = fakeHerdr(t, { panes: VIEW_PANES.filter((p) => p.terminal_id !== T1) });
  assert.equal(
    await run(["watch", VIEW, T1], { ...env, STUDIO_HERDR_BIN: restarted.bin }, LINE.gone + "\r\n"),
    LINE.gone + "\r\n",
  );
  const old = await fakeDaemon(t, { old: true });
  assert.equal(
    await run(
      ["watch", VIEW, T1],
      { ...env, STUDIO_AGENTS_DAEMON: old.url },
      LINE.noTaskViews + "\r\n",
    ),
    LINE.noTaskViews + "\r\n",
  );
  assert.equal(
    await run(
      ["watch", VIEW, T1],
      { ...env, STUDIO_AGENTS_DAEMON: "http://127.0.0.1:9" },
      LINE.unreadable + "\r\n",
    ),
    LINE.unreadable + "\r\n",
  );
  assert.equal(
    await run(["watch", VIEW, T1], { STUDIO_HERDR_BIN: h.bin }, LINE.noTaskViews + "\r\n"),
    LINE.noTaskViews + "\r\n",
    "no daemon",
  );
  assert.ok(!h.calls().some((c) => c[0] === "terminal" && (c.includes(T2) || c.includes(TL))));
  assert.deepEqual(daemon.opened(), []);
});

test("a verified viewer whose access mode isn't the boolean false is watch-only: Type and Take over refused before Herdr", async (t) => {
  for (const [why, viewer] of [
    ["no readOnly", { terminalId: T1 }],
    ["readOnly 'false' as a string", { terminalId: T1, readOnly: "false" }],
  ]) {
    const daemon = await fakeDaemon(t, { preview: PREVIEW(viewer) }),
      h = fakeHerdr(t, { panes: VIEW_PANES });
    const env = { STUDIO_HERDR_BIN: h.bin, STUDIO_AGENTS_DAEMON: daemon.url };
    assert.equal(
      await run(["type", VIEW, T1, "type"], env, LINE.readOnly + "\r\n"),
      LINE.readOnly + "\r\n",
      why,
    );
    assert.equal(
      await run(["type", VIEW, T1, "takeover"], env, LINE.readOnly + "\r\n"),
      LINE.readOnly + "\r\n",
      why,
    );
    assert.deepEqual(
      h.calls().filter((c) => c[1] === "attach"),
      [],
      why,
    );
    assert.equal(
      await run(["watch", VIEW, T1], env, `OBSERVED ${T1}\r\n`),
      `OBSERVED ${T1}\r\n`,
      why,
    );
  }
});

// ttyd starts the wrapper at whatever path the box's SDK has: it must run as a program however that path is reached.
test("the wrapper runs as a program from its own folder, through a symlinked SDK folder and through a path with a space", (t) => {
  const d = fs.realpathSync(scratch(t, "tile-entry-"));
  const real = path.join(d, "sdk"),
    spaced = path.join(d, "with space", "sdk");
  for (const dir of [real, spaced])
    fs.cpSync(path.join(REPO, "tools"), path.join(dir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(d, "box"));
  fs.symlinkSync(real, path.join(d, "box", "sdk"), "dir");
  for (const [how, root] of [
    ["its own folder", real],
    ["a symlinked SDK folder", path.join(d, "box", "sdk")],
    ["a path with a space", spaced],
  ]) {
    let code = 0,
      out;
    try {
      out = execFileSync(process.execPath, [path.join(root, "tools", "herdr-tile.mjs")], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      code = e.status;
      out = `${e.stdout}${e.stderr}`;
    }
    assert.equal(code, 2, `${how}: ran and refused, not a silent exit 0`);
    assert.ok(out.includes(LINE.shape), how);
  }
});
