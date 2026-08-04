// The change signal — poll, a server-minted marker, a last-seen cursor.
//
// Five independent implementations across two codebases invented this same
// shape without coordinating: a poll, a monotonic marker, a cursor. Two of them
// used a server-minted token and worked; the one that computed its marker
// client-side misses changes. So the shape is not an implementation detail to
// abstract away — it IS the primitive, and this is it, shipped once so the next
// surface does not invent a sixth.
//
// THE MARKER IS NORMATIVE, THE TRANSPORT IS NOT. This polls. A runtime may push
// sooner over `/api/events` and a surface that ignores that entirely is still
// fully conformant. Six bespoke polls exist today because the documented signal
// did not fit; a helper that mandated a transport would earn the same fate.
//
// Import it from a surface:
//   import { watchSignal, preserveAcross } from "/signal.js";

// ---- CODE changed vs DATA changed, which are not the same event -------------
// DATA changed  -> apply in place. No reload, no scroll jump, no lost focus.
// CODE changed  -> the served bytes are new, so the page must actually reload.
//
// The code trigger is the runtime's PROCESS IDENTITY, never a file mtime: a
// studio copies surfaces into its runtime directory at boot, so edited source
// does not reach the browser until a restart. Watching the file announces a
// change the page cannot yet see.

const DEFAULT_INTERVAL = 2000;

// Latch on FIRST OBSERVATION, not on the first SUCCESSFUL one. Latching on
// success is a measured bug in the implementation this replaces: a restart that
// straddles startup is never detected, because the first poll that succeeds is
// already the new process and its id becomes the baseline.
export function watchSignal({
  verbs = [],
  interval = DEFAULT_INTERVAL,
  onData = () => {},
  onCode = () => location.reload(),
  onDegraded = () => {},
  fetchImpl = fetch,
} = {}) {
  const cursors = new Map();          // verb -> last-seen marker
  let boot;                           // undefined until the first observation
  let bootSeen = false;
  let stopped = false;
  let degraded = false;

  const settle = (isDegraded, why) => {
    if (isDegraded === degraded) return;
    degraded = isDegraded;
    // Visible, always. Every poll in both reference codebases swallows its
    // failure in a bare catch, which the contract already forbids — and it means
    // a dead provider looks exactly like a quiet one.
    onDegraded({ degraded, reason: why ?? null });
  };

  async function tick() {
    let sawFailure = null;

    try {
      const res = await fetchImpl("/api/contract", { cache: "no-store" });
      if (!res.ok) throw new Error(`contract responded ${res.status}`);
      const next = (await res.json())?.runtime?.boot;
      if (!bootSeen) { boot = next; bootSeen = true; }        // first OBSERVATION
      else if (next && next !== boot) { onCode({ from: boot, to: next }); return; }
    } catch (e) {
      // A failed contract read still counts as an observation: without this the
      // latch waits for success and inherits the bug it exists to avoid.
      bootSeen = true;
      sawFailure = e.message;
    }

    for (const verb of verbs) {
      try {
        const since = cursors.get(verb);
        const url = verb + (verb.includes("?") ? "&" : "?") + "since=" + encodeURIComponent(since ?? "");
        const res = await fetchImpl(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`${verb} responded ${res.status}`);
        const body = await res.json();
        // A marker that moved BACKWARDS or was reissued counts as changed.
        // Monotonicity is the provider's promise; a consumer that trusted it
        // blindly would go silent forever if it were broken, so a surprise fails
        // toward re-reading rather than toward nothing.
        const moved = body.marker !== undefined && body.marker !== since;
        if (body.changed || (since !== undefined && moved)) {
          onData({ verb, marker: body.marker, body, by: body.by ?? null });
        }
        if (body.marker !== undefined) cursors.set(verb, body.marker);
      } catch (e) {
        sawFailure = e.message;
      }
    }

    settle(Boolean(sawFailure), sawFailure);
  }

  const timer = setInterval(() => { if (!stopped) tick(); }, interval);
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, get degraded() { return degraded; } };
}

// ---- state that survives a code reload --------------------------------------
// One app solves this today in a private sessionStorage key and its SIBLING —
// same provider, same trigger — reloads bare and loses everything. Solved once,
// did not propagate. That is the entire argument for it living here: the surface
// says WHAT to keep, not HOW.
//
// The bar, from the app that got it right: "a reload that loses your work is one
// you learn to dread; this one should read as a flicker."
export function preserveAcross(key, { capture, restore, say = () => {} } = {}) {
  const slot = `openrig.preserve.${key}`;
  let restored = false;

  try {
    const raw = sessionStorage.getItem(slot);
    if (raw !== null) {
      sessionStorage.removeItem(slot);   // one-shot: a stale slot must not resurrect
      restore?.(JSON.parse(raw));
      restored = true;
      // Say it ONCE, deliberately. Partly so the user knows the state came back
      // on purpose, and partly so a reload they did not expect is still legible
      // as a reload rather than hidden by a perfect restore.
      say("reloaded with new code — your view was kept");
    }
  } catch { /* a corrupt slot must not stop the surface from loading */ }

  return {
    restored,
    // Call immediately before reloading.
    keep() {
      try { sessionStorage.setItem(slot, JSON.stringify(capture?.() ?? null)); }
      catch { /* quota or private mode: reload without preservation, do not throw */ }
    },
  };
}

// ---- human-wins --------------------------------------------------------------
// Both reference codebases arrived at this independently — `if (st.dirty) return`,
// and a poll that skips while dirty/saving/loading. Promoted to a rule: while a
// surface reports itself dirty, a refresh DEFERS. It does not merge and it does
// not clobber. The deferred change is applied when the surface reports clean.
export function deferWhileDirty(isDirty, apply) {
  let pending = null;
  return {
    offer(change) {
      if (isDirty()) { pending = change; return "deferred"; }
      apply(change); return "applied";
    },
    // Call when the surface becomes clean.
    flush() {
      if (!pending || isDirty()) return false;
      const c = pending; pending = null; apply(c); return true;
    },
    get deferred() { return pending !== null; },
  };
}
