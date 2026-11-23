// The agents view's task views: this box's OpenRig daemon says which agents a task has and which Herdr terminal is each one's
// verified viewer. The Studio only reads and passes that on; it never decides membership itself. Only behind an admission hook
// (contract/server-hooks.md): studio.mjs reads none of this on a loopback-only Studio.
//
//   GET  <daemon>/api/terminal/preview?view=qitem:<id>&provider=herdr   read-only: the task, its members, viewDescriptor and the
//        plan id (behind the daemon's terminal token when it has one)
//   POST <daemon>/api/terminal/viewer/ensure {view, member, provider, expectedPlan}   the person's explicit ensure
// CAPABILITY IS PROBED FROM THE ROUTES, NEVER A VERSION:
//   - task views: the preview of a qitem view answers with a `task`. A daemon without them has no qitem handling and answers 404
//     view_not_found "unknown view '<view>' — not a known rig, a mission:/slice: scope, or a saved-view id"; with them, an
//     unknown task is 404 view_not_found "unknown local queue episode '<id>'". ONLY those two exact answers classify; any other
//     404 (a proxy, a different route, a changed message) proves nothing and is unreadable, never "task_views_unsupported".
//   - ensure: a POST of {} to the ensure route is refused by its own parsing (400 body_invalid, or the bearer's 401/403) before it
//     does anything when the route exists, and 404 when it doesn't. That probe has no effect.
// Never /api/terminal/open: an open has provider effects. Ensure does no relayout, close, takeover or lifecycle (the daemon's
// contract), and the Studio adds none. Membership is not authority to type: a verified viewer may be written to only on the
// person's explicit Type or Take over.
//   - ONE fixed daemon, STUDIO_AGENTS_DAEMON=http://127.0.0.1:<port> (loopback only, no path, query or credentials), never from
//     the request; the view is the only thing taken from the page, and only in its exact shape.
//   - The daemon's terminal token is read from ONE fixed file, STUDIO_AGENTS_DAEMON_TOKEN_FILE (absolute; a regular file owned by
//     this process's user, no group or other access), at each preview, probe and ensure; never from the request, never logged.
//     Unset: they are sent without one (a daemon with no terminal token). A daemon that refuses it (401/403) is unreadable, said so.
//   - A member's terminal id is passed on ONLY when the daemon says its viewer is verified. "unconfirmed" stays unconfirmed;
//     "not-provisioned" has no terminal. A verified viewer is writable only when the daemon says readOnly: false; a missing or
//     non-boolean access mode is watch-only (readOnly: true), never writable.
import fs from "node:fs";
import path from "node:path";

export const VIEW = /^qitem:[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PLAN = /^[0-9a-f]{64}$/;
const SESSION = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TIMEOUT_MS = 8000;
export const UNSUPPORTED = "task_views_unsupported";

export function readAgentsDaemon(env = process.env) {
  const raw = env.STUDIO_AGENTS_DAEMON,
    tf = env.STUDIO_AGENTS_DAEMON_TOKEN_FILE;
  if (raw === undefined || raw === "") return { target: null, describe: null };
  const off = (why) => ({
    target: null,
    describe: `agents  : task views off: STUDIO_AGENTS_DAEMON ${why}`,
  });
  let u;
  try {
    u = new URL(raw);
  } catch {
    return off("isn't a URL");
  }
  if (u.protocol !== "http:") return off("must be http:// (the hop is loopback)");
  if (!LOOPBACK.has(u.hostname))
    return off("must name a loopback host (127.0.0.1, localhost or [::1])");
  if (!u.port) return off("needs a port");
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/"))
    return off("must be only a scheme, a loopback host and a port");
  if (tf !== undefined && tf !== "" && (!path.isAbsolute(tf) || path.normalize(tf) !== tf))
    return off("is set, but STUDIO_AGENTS_DAEMON_TOKEN_FILE must be an absolute, normalised path");
  const base = `http://${u.hostname}:${u.port}`;
  return {
    target: { base, tokenFile: tf || null },
    describe: `agents  : task views from the daemon at ${base} (preview and ensure only, never open)${tf ? ", ensure's bearer from a 0600 file" : ""}`,
  };
}

const getJson = async (url, init = {}) => {
  const r = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
};

// The bearer, or null when no file is configured; throws when the file isn't ours, private and readable. Also the wrapper's
// (herdr-tile.mjs) for its selected-conversation checks: one reader of the token file, not two.
export function bearer(tokenFile) {
  if (!tokenFile) return null;
  const st = fs.statSync(tokenFile);
  if (
    !st.isFile() ||
    (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
    (st.mode & 0o077) !== 0
  )
    throw new Error("token file not private");
  const t = fs.readFileSync(tokenFile, "utf8").trim();
  if (!t || t.length > 4096 || /\s/.test(t)) throw new Error("token file empty or malformed");
  return t;
}

// One task view for the page: { status, body }. Concurrent reads of the same view share one daemon read; nothing kept after.
const inflight = new Map();
export function readTaskView(target, view) {
  if (!inflight.has(view))
    inflight.set(
      view,
      taskView(target, view).finally(() => inflight.delete(view)),
    );
  return inflight.get(view);
}
async function taskView(target, view) {
  const unreadable = (why) => ({
    status: 503,
    body: { ok: false, error: `this workspace's agents couldn't be read just now (${why})` },
  });
  let token, p;
  try {
    token = bearer(target.tokenFile);
  } catch {
    return unreadable("this box's token file for it isn't set up");
  }
  try {
    p = await getJson(
      `${target.base}/api/terminal/preview?${new URLSearchParams({ view, provider: "herdr" })}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
  } catch {
    return unreadable("its OpenRig didn't answer");
  }
  if (p.status === 401 || p.status === 403)
    return unreadable("its OpenRig refused this box's token");
  const b = p.body;
  if (p.status === 404) {
    const said = b?.code === "view_not_found" ? b.error : null;
    if (said === `unknown local queue episode '${view.slice(6)}'`)
      return {
        status: 404,
        body: {
          ok: false,
          code: "view_not_found",
          error: "this task isn't known to this workspace",
        },
      };
    if (
      said ===
      `unknown view '${view}' — not a known rig, a mission:/slice: scope, or a saved-view id`
    )
      return {
        status: 503,
        body: {
          ok: false,
          code: UNSUPPORTED,
          error: "this workspace's OpenRig doesn't have task views yet",
        },
      };
    return unreadable("its OpenRig's answer wasn't one it gives for a task view");
  }
  if (
    p.status !== 200 ||
    !b?.task ||
    !Array.isArray(b.task.members) ||
    typeof b.planId !== "string"
  )
    return unreadable("its OpenRig's answer wasn't a task view");
  const members = b.task.members.map((m) => {
    const out = {
      seat: String(m.seat),
      key: { hostId: m.key?.hostId ?? null, nodeId: m.key?.nodeId ?? null },
      availability: m.availability,
      ...(m.reason ? { reason: String(m.reason) } : {}),
      viewerStatus: m.viewerStatus,
    };
    if (SESSION.test(out.seat)) out.session = out.seat;
    if (m.viewerStatus === "verified" && typeof m.viewer?.terminalId === "string") {
      out.terminal_id = m.viewer.terminalId;
      out.readOnly = m.viewer.readOnly !== false;
    }
    return out;
  });
  return {
    status: 200,
    body: {
      task: {
        qitemId: b.task.qitemId,
        name: b.task.name,
        complete: b.task.complete === true,
        issues: Array.isArray(b.task.issues) ? b.task.issues : [],
      },
      viewDescriptor: b.viewDescriptor ?? null,
      plan: b.planId,
      ensure: await hasEnsure(target, token),
      members,
    },
  };
}

// The ensure route's presence, without effect: {} is refused by its own parsing (400) or its bearer (401/403) when it exists;
// 404 when not.
async function hasEnsure(target, token) {
  try {
    const r = await fetch(`${target.base}/api/terminal/viewer/ensure`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: "{}",
    });
    await r.arrayBuffer().catch(() => {});
    return r.status === 400 || r.status === 401 || r.status === 403;
  } catch {
    return false;
  }
}

// The wrapper's check: is term the VERIFIED viewer of a member of view, now?
// { ok, readOnly } | { ok: false, why: "unverified" | "unreadable" | "unsupported" }.
export async function verifiedViewer(target, view, term) {
  const r = await taskView(target, view);
  if (r.status === 503 && r.body?.code === UNSUPPORTED) return { ok: false, why: "unsupported" };
  if (r.status !== 200) return { ok: false, why: r.status === 404 ? "unverified" : "unreadable" };
  const m = r.body.members.find((x) => x.terminal_id === term);
  return m ? { ok: true, readOnly: m.readOnly } : { ok: false, why: "unverified" };
}

// The ensure body from the page, in its exact shape (nothing else, never a terminal id), or null.
export function ensureBody(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "expectedPlan,member,view") return null;
  const m = o.member;
  if (
    !m ||
    typeof m !== "object" ||
    Array.isArray(m) ||
    Object.keys(m).sort().join(",") !== "hostId,nodeId"
  )
    return null;
  // Strings only: RegExp.test would coerce an array or a number.
  const str = (v, re) => typeof v === "string" && re.test(v);
  if (
    !str(o.view, VIEW) ||
    !str(m.hostId, KEY) ||
    !str(m.nodeId, KEY) ||
    !str(o.expectedPlan, PLAN)
  )
    return null;
  return {
    view: o.view,
    member: { hostId: m.hostId, nodeId: m.nodeId },
    expectedPlan: o.expectedPlan,
  };
}

// The person's explicit ensure, forwarded: { status, body } as the daemon answered (its codes unchanged).
export async function ensureViewer(target, body) {
  let token;
  try {
    token = bearer(target.tokenFile);
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        code: "not_set_up",
        error: "this workspace's ensure isn't set up (its token file)",
      },
    };
  }
  try {
    const r = await getJson(`${target.base}/api/terminal/viewer/ensure`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        view: body.view,
        member: body.member,
        provider: "herdr",
        expectedPlan: body.expectedPlan,
      }),
    });
    if (!r.body || typeof r.body !== "object")
      return {
        status: 502,
        body: { ok: false, error: "this workspace's OpenRig gave no answer to ensure" },
      };
    return { status: r.status, body: r.body };
  } catch {
    return { status: 503, body: { ok: false, error: "this workspace's OpenRig didn't answer" } };
  }
}
