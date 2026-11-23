// One agent terminal in the browser of any admitted person: the fixed command behind the agents view's two ttyds (tools/hosted-terminals.mjs).
//
//   ttyd -i <watch socket> -a    -b /agents/watch -- node <sdk>/tools/herdr-tile.mjs watch          (no -W: read-only by ttyd)
//   ttyd -i <type socket>  -a -W -b /agents/type  -- node <sdk>/tools/herdr-tile.mjs type
//
// ttyd -a appends the browser's ?arg= values (decoded) to that command, so everything after the first argument came from the
// client. It is DATA, never a command or a path: no shell runs, and before Herdr is asked anything the arguments must be exactly
//   watch <terminal id>                    type <terminal id> <type|takeover>
// with a terminal id of Herdr's shape (term_ + hex). Then the id must be one of this box's agent terminals NOW: a pane in Herdr's
// own list (`herdr pane list`) whose label is a seat's logical id (pod.member, as OpenRig's view names its tiles) and whose
// foreground process is `tmux attach` (OpenRig's viewer of that seat), never the dashboard or another pane. Anything else gets one
// plain line and exits before Herdr runs. Herdr is the fixed binary STUDIO_HERDR_BIN (absolute) from ttyd's environment.
// Herdr's list is read fresh for every attach and every list call, and nothing is kept: a Herdr server restart gives every
// terminal a new id (pane ids and labels come back), so an old id is simply not in the list and is refused. Nothing is ever
// matched by pane id or label alone. Labels aren't unique: when two panes carry the same seat label, neither is an agent terminal
// here (both refused, both left out of the list, the label named as ambiguous), never one picked.
// TASK VIEWS: when the tile carries a task view (qitem:<id>), membership is the daemon's, not ours: the id must be the VERIFIED
// viewer of one of that task's members now (tools/task-views.mjs; GET /api/terminal/preview), and in Herdr's list now. No label is
// consulted on that path. A viewer the daemon marks read-only can only be watched.
// LABEL MEMBERSHIP IS INTERIM: for a tile with no task view, a pane's label and its tmux-attach process say what a pane looks
// like, not that it is verified seat membership. agentTerminals() is the one place to replace when OpenRig gives a structured
// host/node -> terminal mapping. The refusal words stay generic either way.
// SIZE: typing (attach) sizes the terminal to its one controller, and the tile is a tmux viewer sharing the seat's window, so the
// agent's terminal size can change while someone types. The seat's process, session and conversation are untouched; its size is
// not.
// HOW A TILE ENDS: Herdr says why a stream ended IN-BAND, a {"type":"terminal.closed","reason":"…"} record, and exits 0 even for a
// refused attach, a takeover or a stale id. So the reason is read from that record or from Herdr's stderr, NEVER from the exit
// code, and every end the person didn't cause gets one line: in use elsewhere (refused), taken over, this terminal changed (not
// found: Herdr restarted), or has ended (anything else, including exit 0 with no reason). A page reads the tile's last line to set
// its state, so these words (LINES) are its contract. The TUI attach (type) keeps the terminal on its stdout, so only its stderr
// is read.
//   watch:    `herdr terminal session observe <id>`, its {"bytes": base64} frames written to the screen. Nothing is read from input.
//   type:     `herdr terminal attach <id>`: Herdr allows one controller per terminal, and a second is refused, which this says as
//             "In use elsewhere" (the page offers Take over).
//   takeover: `herdr terminal attach <id> --takeover`: only on the person's explicit choice; the previous controller is ended.
// Closing the browser ends this process and Herdr's viewer, never the seat: the tile is a tmux attach to the seat's own session.
// THE SELECTED ORIGINAL CONVERSATION: an app's terminal next to an agent's chat carries the person's selection as two more
// arguments, `--node <nodeId> --conversation <selection hash>`, both or neither, never with a task view. The selection hash is
// sha256 of JSON.stringify([nodeId, runtime, canonicalSessionName, resumeType, resumeToken]) (selectionOf below); the raw resume
// token never leaves the server.
//   C1, before attach: the node is read from this box's OpenRig (/api/rigs, then each rig's nodes: exactly one with that id), its
//       hash must still be the held selection, its logical id must be this terminal's verified seat label (so checking A and
//       attaching B can't pass), and GET /api/sessions/<session>/generation-record-expected must answer 200 with identityContract 1
//       and checkedIdentity == {nodeId, sessionName, runtime, nativeId}. Anything else (400, 409, a 404 from an older daemon, no
//       answer) attaches nothing: one line, and the app stays chat-only.
//   C2, while attached: GET /api/events?replay=0 is followed (Last-Event-ID on reconnect; an end or error is a recheck at once),
//       C1 is rerun on agent.session_identity / seat.fresh_launched / seat.handover_completed / seat.runtime_changed /
//       session.detached for that node, and every recheckMs() without an event; on anything but C1's 200 Herdr's child is ended
//       with one line.
//   C3: nothing is cached. ttyd starts this wrapper fresh for each WebSocket, so every reconnect runs C1 again.
//   C4, Type only: input goes through this process, not inherited, and C1 runs before any input chunk holding an Enter (CR or
//       LF) is forwarded. Cost: one check per such chunk (a paste is one chunk), never two at once; input waits in order.
// LIMITS, said plainly: each check is a moment, not a lock. A change between a check and attach, or between a check and the next
// Enter, isn't caught; keys typed between a change and the close reach the replacement; output is shown until the close. A change
// that sends no event is caught by the interval or the next reconnect. Nothing here pins a terminal continuously.
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW, bearer, readAgentsDaemon, verifiedViewer } from "./task-views.mjs";

const ID = /^term_[0-9a-f]{1,64}$/;
const SEAT = /^[a-z0-9][a-z0-9-]{0,39}\.[a-z0-9][a-z0-9-]{0,39}$/;
export const LINES = {
  shape: "This isn't one of this workspace's agent terminals.",
  setup: "The agents view isn't set up on this workspace yet.",
  gone: "This agent's terminal isn't open in this workspace now.",
  unreadable: "The agents in this workspace couldn't be read just now. Try again in a moment.",
  inUse:
    "In use elsewhere: this agent's terminal is open in another window. Watch it, or Take over.",
  ambiguous:
    "Two terminals have this agent's name, so neither is shown. Ask your team to tell them apart.",
  takenOver: "Taken over in another window. Watch it, or Take over.",
  changed: "This terminal changed; reloading.",
  ended: "This agent's terminal has ended.",
  readOnly: "This viewer is read-only, so it can only be watched.",
  noTaskViews: "This workspace's OpenRig doesn't have task views yet.",
  notConfirmed:
    "This agent's selected conversation couldn't be confirmed, so its terminal stays closed.",
  conversationChanged: "This agent's conversation changed; this terminal closed.",
};

// The line for a tile that ended, from Herdr's own reason (in-band record or stderr), never its exit code.
export function endLine(reason) {
  if (/already has an attached client/i.test(reason)) return LINES.inUse;
  if (/taken over/i.test(reason)) return LINES.takenOver;
  if (/not found/i.test(reason)) return LINES.changed;
  return LINES.ended;
}
const closedReason = (line) => {
  try {
    const o = JSON.parse(line);
    return o?.type === "terminal.closed" ? String(o.reason ?? "") : null;
  } catch {
    return null;
  }
};

// The exact arguments, or null.
// With a task view first: watch <view> <id>; type <view> <id> <type|takeover>. Without one: watch <id>; type <id> <mode>.
// With the selected conversation (see the header): the same, followed by --node <nodeId> --conversation <hash>, never with a view.
export function parseArgs(argv) {
  const [route, ...all] = argv;
  const s = splitOriginal(all);
  if (!s) return null;
  const a = s.rest,
    original = s.original;
  const mode = (m) => m === "type" || m === "takeover";
  if (route === "watch" && a.length === 1 && ID.test(a[0]))
    return { route, id: a[0], mode: "watch", view: null, original };
  if (route === "type" && a.length === 2 && ID.test(a[0]) && mode(a[1]))
    return { route, id: a[0], mode: a[1], view: null, original };
  if (original) return null;
  if (route === "watch" && a.length === 2 && VIEW.test(a[0]) && ID.test(a[1]))
    return { route, id: a[1], mode: "watch", view: a[0], original };
  if (route === "type" && a.length === 3 && VIEW.test(a[0]) && ID.test(a[1]) && mode(a[2]))
    return { route, id: a[1], mode: a[2], view: a[0], original };
  return null;
}
const NODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  SELECTION = /^[0-9a-f]{64}$/;
// The trailing selection pair, both or neither: { rest, original: {node, conversation} | null }, or null when malformed. Also
// used by tools/hosted-terminals.mjs, so ttyd is given only these shapes.
export function splitOriginal(args) {
  const i = args.indexOf("--node"),
    j = args.indexOf("--conversation");
  if (i < 0 && j < 0) return { rest: args, original: null };
  if (
    i !== args.length - 4 ||
    j !== args.length - 2 ||
    !NODE.test(args[i + 1] ?? "") ||
    !SELECTION.test(args[j + 1] ?? "")
  )
    return null;
  return { rest: args.slice(0, -4), original: { node: args[i + 1], conversation: args[j + 1] } };
}
// The selection hash of an OpenRig node. One formula on both sides of the tile URL; the tests pin it with shared vectors.
export const selectionOf = (n) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([n.nodeId, n.runtime, n.canonicalSessionName, n.resumeType, n.resumeToken]),
    )
    .digest("hex");
export function herdrBin(env = process.env) {
  const b = env.STUDIO_HERDR_BIN;
  if (typeof b !== "string" || !path.isAbsolute(b) || path.normalize(b) !== b) return null;
  try {
    fs.accessSync(b, fs.constants.X_OK);
    return fs.statSync(b).isFile() ? b : null;
  } catch {
    return null;
  }
}
const json = (bin, args) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 << 20 }, (e, out) => {
      if (e) return reject(e);
      try {
        resolve(JSON.parse(out));
      } catch (x) {
        reject(x);
      }
    }),
  );
// A foreground process that is OpenRig's viewer of a seat: `tmux attach …`. The program is argv0 when Herdr gives it, else the
// basename of argv[0]: Herdr on Linux can leave argv0 out ({argv: ["tmux","attach","-f","ignore-size","-t",…], cmdline, name:
// "tmux: client", pid}). Never from `name` (a display title).
const isTmuxAttach = (x) => {
  if (!x || !Array.isArray(x.argv) || x.argv[1] !== "attach") return false;
  const prog =
    typeof x.argv0 === "string" && x.argv0
      ? x.argv0
      : typeof x.argv[0] === "string"
        ? path.basename(x.argv[0])
        : "";
  return prog === "tmux";
};
// This box's agent terminals now: { terminals: [{ seat, terminal_id, pane_id, status }], ambiguous: [{ seat, terminal_ids }] }.
// Throws when Herdr can't be read. Interim membership (see the header): label shape + a tmux-attach foreground process; a label
// two panes share is ambiguous, whatever runs in them.
export async function agentTerminals(bin) {
  const panes = (await json(bin, ["pane", "list"]))?.result?.panes;
  if (!Array.isArray(panes)) throw new Error("herdr pane list gave no panes");
  const labelled = panes.filter(
    (p) =>
      p &&
      typeof p.terminal_id === "string" &&
      ID.test(p.terminal_id) &&
      typeof p.label === "string" &&
      SEAT.test(p.label),
  );
  const ids = new Map();
  for (const p of labelled) ids.set(p.label, [...(ids.get(p.label) || []), p.terminal_id]);
  const ambiguous = [...ids]
    .filter(([, t]) => t.length > 1)
    .map(([seat, terminal_ids]) => ({ seat, terminal_ids }));
  const out = [];
  for (const p of labelled) {
    if (ids.get(p.label).length > 1) continue;
    const fg = (await json(bin, ["pane", "process-info", "--pane", String(p.pane_id)]))?.result
      ?.process_info?.foreground_processes;
    // No foreground_processes array is an answer Herdr didn't give: the whole read is unreadable, never "not an agent". An empty
    // array is a real answer: nothing in the foreground.
    if (!Array.isArray(fg))
      throw new Error(`herdr pane process-info gave no foreground processes for pane ${p.pane_id}`);
    if (!fg.some(isTmuxAttach)) continue;
    out.push({
      seat: p.label,
      terminal_id: p.terminal_id,
      pane_id: p.pane_id,
      status: typeof p.agent_status === "string" ? p.agent_status : null,
    });
  }
  return { terminals: out, ambiguous };
}

// ---- the selected original conversation (C1-C4; see the header) ----
const BOUND = new Set(["codex", "claude-code"]);
const CORE_MS = 5000;
const TRIGGERS = new Set([
  "agent.session_identity",
  "seat.fresh_launched",
  "seat.handover_completed",
  "seat.runtime_changed",
  "session.detached",
]);
// Seconds, never a tight loop: each C1 runs a process census and native resolution on the daemon. STUDIO_ORIGINAL_RECHECK_MS
// (1000-60000) only shortens or lengthens it; anything else is the default.
export function recheckMs(env = process.env) {
  const n = Number(env.STUDIO_ORIGINAL_RECHECK_MS);
  return Number.isInteger(n) && n >= 1000 && n <= 60000 ? n : 5000;
}
// C1, read fresh every time: { ok: true, tuple } or { ok: false, why }. why: "unreadable" (the daemon didn't answer as it should)
// or "changed" (no single node, a different selection, another seat, or the daemon's check refused).
export async function checkOriginal(target, sel, seatLabel, fetchImpl = fetch) {
  let token;
  try {
    token = bearer(target.tokenFile);
  } catch {
    return { ok: false, why: "unreadable" };
  }
  const get = async (p) => {
    try {
      const r = await fetchImpl(target.base + p, {
        redirect: "manual",
        signal: AbortSignal.timeout(CORE_MS),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      let body = null;
      try {
        body = await r.json();
      } catch {}
      return { status: r.status, body };
    } catch {
      return { status: 0, body: null };
    }
  };
  const rigs = await get("/api/rigs");
  const list = Array.isArray(rigs.body) ? rigs.body : rigs.body?.rigs;
  if (rigs.status !== 200 || !Array.isArray(list)) return { ok: false, why: "unreadable" };
  const found = [];
  for (const rig of list) {
    if (typeof rig?.id !== "string") return { ok: false, why: "unreadable" };
    const nodes = await get(`/api/rigs/${encodeURIComponent(rig.id)}/nodes`);
    if (nodes.status !== 200 || !Array.isArray(nodes.body)) return { ok: false, why: "unreadable" };
    for (const n of nodes.body) if (n?.nodeId === sel.node) found.push(n);
  }
  if (found.length !== 1) return { ok: false, why: "changed" };
  const n = found[0];
  if (
    !BOUND.has(n.runtime) ||
    typeof n.resumeToken !== "string" ||
    !n.resumeToken ||
    typeof n.canonicalSessionName !== "string"
  )
    return { ok: false, why: "changed" };
  if (selectionOf(n) !== sel.conversation) return { ok: false, why: "changed" };
  if (n.logicalId !== seatLabel) return { ok: false, why: "changed" };
  const tuple = {
    nodeId: n.nodeId,
    sessionName: n.canonicalSessionName,
    runtime: n.runtime,
    nativeId: n.resumeToken,
  };
  const q = new URLSearchParams({
    expectedNodeId: tuple.nodeId,
    expectedRuntime: tuple.runtime,
    expectedNativeId: tuple.nativeId,
  });
  const c1 = await get(
    `/api/sessions/${encodeURIComponent(tuple.sessionName)}/generation-record-expected?${q}`,
  );
  const got = c1.body?.checkedIdentity;
  const same =
    c1.status === 200 &&
    c1.body?.identityContract === 1 &&
    got &&
    typeof got === "object" &&
    Object.keys(got).length === 4 &&
    Object.keys(tuple).every((k) => got[k] === tuple[k]);
  if (same) return { ok: true, tuple };
  return { ok: false, why: c1.status === 0 ? "unreadable" : "changed" };
}
// C2: the daemon's persisted events, from now on (replay=0), resumed with Last-Event-ID; calls onHint() for a trigger on this
// node and for every end or error of the stream (then reconnects after a second). stop() ends it.
export function followEvents(target, nodeId, onHint, fetchImpl = fetch) {
  let lastId = null,
    stopped = false,
    ctl = null;
  const run = async () => {
    while (!stopped) {
      ctl = new AbortController();
      let token = null;
      try {
        token = bearer(target.tokenFile);
      } catch {}
      try {
        const r = await fetchImpl(`${target.base}/api/events?replay=0`, {
          signal: ctl.signal,
          headers: {
            accept: "text/event-stream",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(lastId !== null ? { "last-event-id": lastId } : {}),
          },
        });
        if (r.status !== 200 || !r.body) throw new Error("no stream");
        const dec = new TextDecoder();
        let buf = "",
          id = null,
          data = "";
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            if (line === "") {
              if (id !== null) lastId = id;
              let e = null;
              try {
                e = JSON.parse(data);
              } catch {}
              if (e && TRIGGERS.has(e.type) && e.nodeId === nodeId) onHint(`event ${e.type}`);
              id = null;
              data = "";
            } else if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:"))
              data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
          }
        }
      } catch {}
      if (stopped) return;
      onHint("stream ended");
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  run();
  return {
    stop: () => {
      stopped = true;
      ctl?.abort();
    },
    lastId: () => lastId,
  };
}

function say(line, code = 2) {
  process.stdout.write(line + "\r\n");
  setTimeout(() => process.exit(code), 300);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a) return say(LINES.shape);
  const bin = herdrBin();
  if (!bin) return say(LINES.setup);
  if (a.view) {
    // A task view: the daemon's VERIFIED viewer of a member of this task, now; never a label match. The id must also be in
    // Herdr's own list now (a Herdr restart renumbers every terminal). Unverified reads as "isn't open now", so the page re-reads
    // its list.
    const d = readAgentsDaemon().target;
    if (!d) return say(LINES.noTaskViews);
    let v;
    try {
      v = await verifiedViewer(d, a.view, a.id);
    } catch {
      return say(LINES.unreadable);
    }
    if (!v.ok)
      return say(
        v.why === "unsupported"
          ? LINES.noTaskViews
          : v.why === "unreadable"
            ? LINES.unreadable
            : LINES.gone,
      );
    if (v.readOnly && a.mode !== "watch") return say(LINES.readOnly);
    let panes;
    try {
      panes = (await json(bin, ["pane", "list"]))?.result?.panes;
    } catch {
      return say(LINES.unreadable);
    }
    if (!Array.isArray(panes)) return say(LINES.unreadable);
    if (!panes.some((p) => p?.terminal_id === a.id)) return say(LINES.gone);
  } else {
    // No task view: membership by label (interim, see the header).
    let now;
    try {
      now = await agentTerminals(bin);
    } catch {
      return say(LINES.unreadable);
    }
    if (now.ambiguous.some((x) => x.terminal_ids.includes(a.id))) return say(LINES.ambiguous);
    const t = now.terminals.find((x) => x.terminal_id === a.id);
    if (!t) return say(LINES.gone);
    a.seatLabel = t.seat;
  }
  // C1: the selected original conversation, checked before anything attaches (see the header).
  const daemon = a.original ? readAgentsDaemon().target : null;
  if (a.original) {
    if (!daemon) return say(LINES.notConfirmed);
    const c = await checkOriginal(daemon, a.original, a.seatLabel);
    if (!c.ok) return say(LINES.notConfirmed);
  }
  const args =
    a.mode === "watch"
      ? ["terminal", "session", "observe", a.id]
      : ["terminal", "attach", a.id, ...(a.mode === "takeover" ? ["--takeover"] : [])];
  const gated = a.original && a.mode !== "watch"; // C4: Type's input goes through this process
  const child = spawn(bin, args, {
    stdio:
      a.mode === "watch"
        ? ["ignore", "pipe", "pipe"]
        : [gated ? "pipe" : "inherit", "inherit", "pipe"],
  });
  // The person closing the tile (ttyd's hangup) ends Herdr's viewer quietly; any other end says why.
  let leaving = false,
    closedLine = null;
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"])
    process.on(sig, () => {
      leaving = true;
      child.kill(sig);
    });
  if (a.original) {
    // C2 + C4: one check at a time, in order; anything but C1's 200 ends Herdr's child with one line.
    let serial = Promise.resolve(),
      pending = false,
      ended = false;
    const end = (why) => {
      if (ended) return;
      ended = true;
      closedLine = why === "unreadable" ? LINES.notConfirmed : LINES.conversationChanged;
      stopAll();
      child.kill("SIGTERM");
    };
    const check = () =>
      (serial = serial.then(async () => {
        if (ended) return false;
        const c = await checkOriginal(daemon, a.original, a.seatLabel);
        if (!c.ok) end(c.why);
        return c.ok;
      }));
    const hint = () => {
      if (pending || ended) return;
      pending = true;
      check().finally(() => {
        pending = false;
      });
    };
    const events = followEvents(daemon, a.original.node, hint);
    const timer = setInterval(hint, recheckMs());
    const stopAll = () => {
      clearInterval(timer);
      events.stop();
      process.stdin.pause();
    };
    child.on("close", stopAll);
    if (gated) {
      child.stdin.on("error", () => {});
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(true);
        } catch {}
      }
      let input = Promise.resolve();
      process.stdin.on("data", (chunk) => {
        input = input.then(async () => {
          if (ended) return;
          // C4: an Enter waits for its check.
          if ((chunk.includes(13) || chunk.includes(10)) && !(await check())) return;
          if (!ended) child.stdin.write(chunk);
        });
      });
      process.stdin.on("end", () => {
        input.then(() => child.stdin.end());
      });
    }
  }
  let reason = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    reason += d;
  });
  if (a.mode === "watch") {
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const closed = closedReason(line);
        if (closed !== null) {
          reason += closed;
          continue;
        }
        try {
          const b = JSON.parse(line)?.bytes;
          if (typeof b === "string") process.stdout.write(Buffer.from(b, "base64"));
        } catch {}
      }
    });
  }
  // "close": after its last record is read.
  child.on("close", () => (leaving ? process.exit(0) : say(closedLine ?? endLine(reason), 1)));
}
// Run as a program only when this file IS the program. Compare real paths: Node resolves symlinks in the main module's
// import.meta.url but leaves process.argv[1] as given, so a `file://${argv[1]}` comparison is false whenever the SDK is
// reached through a symlinked folder (or a path with a space), and the wrapper would load, do nothing and exit 0.
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();
