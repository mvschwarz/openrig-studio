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
// WHEN you call this is part of the contract, and it is the kind of requirement
// that fails silently: a restore that lands AFTER first paint still restores, so
// it passes every functional check while the user watches an empty view fill in
// — the thing "smooth" is defined against. Measured in a browser: called from a
// deferred module script the restore lands ~40ms before first contentful paint;
// called from window.onload or after an await it lands after it.
//
// The helper cannot fix the call site, so it reports it. readyState "complete"
// means the load event has fired and paint is definitely behind us. Warned, not
// refused — the state still comes back, because a late restore beats none.
//
// HONEST LIMIT: this catches the definite case, not every late one. An await
// inside a deferred script can land after a paint while readyState is still
// "interactive", and nothing here sees that.
const calledAfterPaint = () => globalThis.document?.readyState === "complete";

export function preserveAcross(key, { capture, restore, say = () => {}, onLate } = {}) {
  const slot = `openrig.preserve.${key}`;
  let restored = false;

  try {
    const raw = sessionStorage.getItem(slot);
    if (raw !== null) {
      if (calledAfterPaint()) {
        const warn = "preserveAcross ran after the load event, so the restore lands AFTER first " +
          "paint and the user sees the un-restored view first. Call it from a deferred module " +
          "script — see contract/change-signal.md.";
        if (onLate) onLate(warn); else globalThis.console?.warn?.(warn);
      }
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

// ---- the declared list, read from the surface's OWN row ----------------------
// This is the link that turns `preserve` from a field the manifest CARRIES into
// one something CONSUMES. Without it the declaration is the shape that reads as
// done and does nothing — the class this seam has removed repeatedly.
//
// Takes its fetch for the same reason watchSignal does: a consumer can test its
// own adoption with no browser and no live provider.
export async function declaredKinds({ surfaceId, fetchImpl = fetch, manifest = "/surfaces.json" } = {}) {
  const res = await fetchImpl(manifest, { cache: "no-store" });
  if (!res.ok) throw new Error(`${manifest} responded ${res.status}`);
  const rows = (await res.json())?.surfaces ?? [];
  const row = rows.find((r) => r && r.id === surfaceId);

  // "my row is missing" and "my row declares nothing" are different facts and a
  // surface can act on the difference — the first is a registration problem, the
  // second is a deliberate choice. Collapsing them to [] would hide the first.
  if (!row) return { kinds: [], found: false, problem: `no row with id "${surfaceId}" in ${manifest}` };
  if (row.preserve === undefined) return { kinds: [], found: true, problem: null };
  if (!Array.isArray(row.preserve)) {
    // Declared and unusable is NOT the same as undeclared, and it must not read
    // as an empty list. Absence is silent because the field is optional; a
    // declaration that does nothing is not.
    return { kinds: [], found: true, problem: `preserve must be an array of kind names, got ${typeof row.preserve}` };
  }
  return { kinds: row.preserve, found: true, problem: null };
}

// Drive capture/restore from a declared list.
//
// THE ADAPTER IS REQUIRED AND HAS NO DEFAULT, deliberately. Binding the standard
// kinds (scroll, selection, form, playhead) to real DOM is browser work that
// cannot be honestly verified from node, and shipping an unverified default
// would be asserting behaviour nothing here has run. A surface supplies its own
// adapter today; the standard one lands with a browser pass behind it. See the
// conformance table in contract/change-signal.md.
export const STANDARD_KINDS = ["scroll", "selection", "form", "playhead"];

// ---- the standard adapter ----------------------------------------------------
// ⚠️ THE DOM BINDINGS BELOW ARE NOT YET BROWSER-VERIFIED. They are written to be
// handed to verification, not claimed as working — see the conformance table in
// contract/change-signal.md, which carries them as unverified until a real
// browser pass lands. Do not cite this code as evidence that the standard kinds
// work; cite the pass.
//
// SELECTION IS DELIBERATELY NOT IMPLEMENTED, and that is a measured decision
// rather than an omission. Across the surveyed applications `selection` means
// asset NAMES, opaque canvas shape IDS, absolute file PATHS, and timeline SLOT
// IDS — four different types sharing nothing but the word. A generic adapter
// that picked one would be right for a single app and silently wrong for the
// rest, which is worse than declining: the surface would declare `selection`,
// see no error, and lose it on every reload. So `supports("selection")` is
// FALSE, the declaring surface is told through onUnsupported, and a surface that
// knows what its selection actually is composes its own adapter for it.
export function standardAdapter({ win = globalThis, doc = globalThis.document } = {}) {
  // Restoring these is either impossible or unwise: a file input cannot be set
  // programmatically, and a password captured into sessionStorage is a
  // credential written to disk-backed storage by a convenience feature.
  const SKIP_INPUT = new Set(["password", "file"]);
  const fieldKey = (el) => el.name || el.id || null;

  const kinds = {
    scroll: {
      get: () => ({
        win: { x: win.scrollX ?? 0, y: win.scrollY ?? 0 },
        // Elements opt IN by attribute rather than being discovered, so this
        // never guesses which of several scrollers the surface meant.
        els: [...(doc?.querySelectorAll?.("[data-preserve-scroll]") ?? [])]
          .map((el) => [fieldKey(el), el.scrollTop, el.scrollLeft])
          .filter(([k]) => k),
      }),
      set: (v) => {
        if (!v || typeof v !== "object") return;
        if (v.win) win.scrollTo?.(v.win.x ?? 0, v.win.y ?? 0);
        for (const [key, top, left] of v.els ?? []) {
          const el = doc?.querySelector?.(`[data-preserve-scroll][name="${key}"], #${CSS?.escape?.(key) ?? key}`);
          if (el) { el.scrollTop = top; el.scrollLeft = left; }
        }
      },
    },

    form: {
      get: () => {
        const out = {};
        for (const el of doc?.querySelectorAll?.("input, select, textarea") ?? []) {
          const key = fieldKey(el);
          if (!key || SKIP_INPUT.has(el.type)) continue;
          out[key] = el.type === "checkbox" || el.type === "radio" ? { checked: el.checked } : { value: el.value };
        }
        return out;
      },
      set: (v) => {
        if (!v || typeof v !== "object") return;
        for (const el of doc?.querySelectorAll?.("input, select, textarea") ?? []) {
          const key = fieldKey(el);
          if (!key || SKIP_INPUT.has(el.type) || !Object.hasOwn(v, key)) continue;
          const saved = v[key];
          if (Object.hasOwn(saved, "checked")) el.checked = saved.checked;
          else el.value = saved.value;
        }
      },
    },

    playhead: {
      get: () => [...(doc?.querySelectorAll?.("video, audio") ?? [])]
        .map((el, i) => [fieldKey(el) || String(i), el.currentTime, !el.paused])
        .filter(([k]) => k !== null),
      set: (v) => {
        const media = [...(doc?.querySelectorAll?.("video, audio") ?? [])];
        for (const [key, time, playing] of Array.isArray(v) ? v : []) {
          const el = media.find((m, i) => (fieldKey(m) || String(i)) === key);
          if (!el) continue;
          el.currentTime = time;
          // Resuming playback is an ACTION, not a value, so it is attempted and
          // its failure ignored: a browser may refuse programmatic play, and a
          // rejected promise must not take the rest of the restore down with it.
          if (playing) el.play?.()?.catch?.(() => {});
        }
      },
    },
  };

  return {
    supports: (kind) => Object.hasOwn(kinds, kind),
    get: (kind) => kinds[kind]?.get(),
    set: (kind, value) => kinds[kind]?.set(value),
  };
}

export function preserveDeclared(key, kinds, { adapter, say, onUnsupported = () => {} } = {}) {
  if (!adapter || typeof adapter.get !== "function" || typeof adapter.set !== "function") {
    // Throw rather than no-op. A preserve helper that silently preserved nothing
    // is the exact failure this whole declaration exists to avoid.
    throw new Error("preserveDeclared needs an adapter: { get(kind), set(kind, value), supports?(kind) }");
  }
  const list = Array.isArray(kinds) ? kinds : [];
  const supported = [], unsupported = [];
  for (const k of list) (adapter.supports ? adapter.supports(k) : true) ? supported.push(k) : unsupported.push(k);
  // Reported, never dropped quietly: a kind the surface declared and nothing can
  // keep is a promise the user will notice being broken.
  if (unsupported.length) onUnsupported(unsupported);

  return preserveAcross(key, {
    capture: () => Object.fromEntries(supported.map((k) => [k, adapter.get(k)])),
    restore: (state) => {
      if (!state || typeof state !== "object") return;
      for (const k of supported) if (Object.hasOwn(state, k)) adapter.set(k, state[k]);
    },
    say,
  });
}

// ---- addressing state WITHIN a surface ---------------------------------------
// The other end of the same problem as focus. The shell's `?s=<id>` picks WHICH
// surface is open; across every surveyed application there is not one use of
// location.hash, URLSearchParams or pushState, so nothing addresses state INSIDE
// one. There is no way to link to, restore, or hand an agent "the thing I am
// looking at" by reference.
//
// THE SHELL OWNS THE QUERY, THE SURFACE OWNS THE HASH. That split is why these
// write to the hash and leave the query untouched: `?s=` belongs to the shell,
// and a surface that wrote there would fight the thing hosting it.
//
// Pure functions on a URL STRING rather than on `location`, for the same reason
// watchSignal takes its fetch: a consumer can test its own addressing without a
// browser.

export function readAddress(href) {
  const hash = new URL(href).hash.replace(/^#/, "");
  return hash ? Object.fromEntries(new URLSearchParams(hash)) : {};
}

export function writeAddress(href, state) {
  const url = new URL(href);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(state ?? {})) {
    // A blank value addresses nothing, and carrying it would put `&k=` in a URL
    // a human is expected to read and paste.
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const encoded = params.toString();
  url.hash = encoded;
  // Setting an empty hash can leave a bare trailing "#", which is a different
  // string for no reason and shows up in anything comparing URLs.
  return encoded ? url.toString() : url.toString().replace(/#$/, "");
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

// ---- drive: letting an agent operate this surface ----------------------------
// The surface half of `/api/drive`. A surface adopts this and becomes drivable;
// one that does not is unaffected, like everything else in this file.
//
// LATEST INTENT WINS, AND SUPERSEDED OPS ARE NEVER APPLIED. If three ops arrive
// while one is still being realised, the surface applies the newest and DROPS the
// two in between — it does not queue them. Replaying superseded intent animates
// through states nobody asked to see and, worse, leaves a slow page acting on
// instructions that were true minutes ago while looking perfectly healthy.
//
// APPLICATION IS SERIALISED. `apply` is awaited, and an op arriving mid-flight is
// held as `next` rather than started concurrently — two overlapping applications
// interleave their writes and land the surface in a state neither op described.
// Whatever arrives during a flight, only the LAST one runs when it lands.
export function driveSurface({
  apply,
  fetchImpl = fetch,
  endpoint = "/api/drive",
  intervalMs = 350,
  onError = () => {},
} = {}) {
  if (typeof apply !== "function") throw new TypeError("driveSurface needs an apply(op) function");

  let marker = null;      // last marker seen, so `?since=` can be honest
  let seen = 0;           // highest generation already applied
  let next = null;        // newest op that arrived while one was being applied
  let flying = false;
  let stopped = false;
  let timer = null;

  async function run(op) {
    flying = true;
    try {
      while (op) {
        // Re-read `next` AFTER the await, not before: anything that arrived
        // during this application supersedes what we were about to do next.
        await apply(op);
        op = next;
        next = null;
      }
    } finally {
      flying = false;
    }
  }

  // Exposed so a surface can hand an op straight in — a shell delivering by
  // postMessage, or a test — without a transport in the way.
  function offer(op) {
    if (!op || typeof op.gen !== "number" || op.gen <= seen) return "superseded";
    seen = op.gen;
    if (flying) { next = op; return "queued-latest"; }
    run(op).catch(onError);
    return "applying";
  }

  async function poll() {
    if (stopped) return;
    try {
      const url = marker === null ? endpoint : `${endpoint}?since=${encodeURIComponent(marker)}`;
      const r = await (await fetchImpl(url, { cache: "no-store" })).json();
      if (r && r.ok) {
        marker = r.marker ?? marker;
        if (r.changed && r.op) offer(r.op);
      }
    } catch (e) {
      // The runtime going away must not kill the page. A surface that stopped
      // polling on the first blip would need a manual reload to become drivable
      // again, which is exactly the state this primitive exists to remove.
      onError(e);
    }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  }

  poll();
  return {
    offer,
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    get applied() { return seen; },
  };
}
