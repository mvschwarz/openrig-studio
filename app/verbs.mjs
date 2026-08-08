// WHICH VERBS THIS RUNTIME OWNS — declared ONCE, consumed by both the runtime
// that serves them and the compositor that routes them.
//
// WHY THIS FILE EXISTS. `/api/focus` and `/api/drive` were reserved in the
// compositor after a provider shadowed them and a documented verb 404'd. That fix
// worked and DID NOT GENERALISE: `/api/capture-target` was added later, nobody
// remembered the second list, and a one-provider studio routed it to a provider
// that had never declared it — public 404, internal 200, and `/api/contract`
// advertising the capability the whole time.
//
// Two hand-maintained lists in two files is two places computing one property. So
// there is one list, and the compositor DERIVES its reserved set from it rather
// than restating it. A verb added here is reserved by construction.
//
// THE MEMBERSHIP TEST IS WHOSE STATE THE VERB ANSWERS, not importance:
// runtime-owned means nothing else CAN answer it, so nothing else may.

/** Verbs answering state held in the runtime process. Reserved by construction. */
export const RUNTIME_OWNED_VERBS = Object.freeze([
  "/api/contract",        // this runtime describing itself
  "/api/events",          // this runtime's change stream
  "/api/factory/state",   // this runtime's view of the floor
  "/api/focus",           // focusRecord — module state here
  "/api/drive",           // driveOp + generation — module state here
  "/api/capture-target",  // captureTarget, resolved against THIS box's bound roots
]);

/**
 * Verbs answering data on the box, which something else may legitimately answer
 * better — a real studio serves real directories and its own annotation store.
 * Reserving these would forbid the substitution a provider exists for.
 */
export const SUBSTITUTABLE_VERBS = Object.freeze([
  "/api/files/tree", "/api/files/read", "/api/files/raw", "/api/files/search",
  "/api/annotations",
]);

/**
 * A map whose keys are UNTRUSTED VOCABULARY.
 *
 * Root kinds are an open vocabulary by contract, so `constructor`, `toString` and
 * `__proto__` are valid spellings. On a plain object they are INHERITED, so an
 * unbound kind named `constructor` answered with Object's constructor instead of
 * undefined and turned an honest 400 into a 500. This class was already guarded
 * in the SDK's other root-binding code and the newer map reopened it — which is
 * why the primitive is shared rather than the check repeated.
 *
 * Use this for EVERY runtime map keyed by something a caller can name.
 */
export const openVocabMap = (entries = []) => {
  const m = Object.create(null);
  for (const [k, v] of entries) m[k] = v;
  return m;
};

/** Own-property lookup. Returns `undefined` for anything inherited. */
export const lookup = (map, key) =>
  (map && typeof key === "string" && Object.hasOwn(map, key)) ? map[key] : undefined;

/**
 * Does a request path match a declared verb?
 *
 * **A verb ending in `/` is a PREFIX**, exactly as `app-manifest.md` defines it for
 * provider verbs — `/api/export-status/` matches `/api/export-status/<jobId>`.
 * Anything else matches exactly.
 *
 * This exists because the compositor matched reserved verbs with `Set.has()`, i.e.
 * EXACT ONLY, while the verb contract it shares a vocabulary with supports
 * prefixes. A runtime-owned parameterized route would therefore have fallen
 * through to a sole provider — the original shadowing defect, reopened by a shape
 * the guard could not express.
 */
export const verbMatches = (declared, pathname) =>
  declared.endsWith("/") ? pathname.startsWith(declared) : pathname === declared;

/** True when any runtime-owned verb claims this path. */
export const isRuntimeOwned = (pathname) =>
  RUNTIME_OWNED_VERBS.some((v) => verbMatches(v, pathname));

// ---- the routing surface tripwire ------------------------------------------
//
// PM's ruling, third round on this class: OPT-IN DISCOVERY IS THE HOLE. A
// registration wrapper (`serves()`) is a convention — a raw handler that never
// calls it serves live while `runtime.routes` and the classifier stay blind.
// The mechanism is now a TABLE the dispatcher consults at request time, and the
// same table is what `runtime.routes` and classification enumerate: one
// structure, two readers, so a route cannot serve without a row.
//
// What a table cannot prevent is a raw arm typed ABOVE the dispatch — JavaScript
// is open text. That is what this tripwire is for: every textual `/api` mention
// in the runtime source must live between the two markers that fence the table
// and its dispatcher. A raw arm in ANY spelling — exact, prefix, regex — carries
// the `/api` literal it routes on, so it trips this in all forms, and the fix it
// forces is "add a table row", which is the mechanism. Over-blocking is safe;
// silence is not.
//
// (Its predecessor here was `discoverApiRoutes`, a regex over source recognising
// specific comparison spellings — an approximation of the router, exactly what
// PM ruled against, and each new spelling was invisible until added. A negative
// tripwire has no per-spelling blind spot: it needs no grammar of arms, only the
// literal every arm must carry.)

export const ROUTING_SURFACE_BEGIN = ">>> API ROUTING SURFACE";
export const ROUTING_SURFACE_END = "<<< API ROUTING SURFACE";

/**
 * Violations of "every `/api` mention lives inside the routing surface".
 * Returns `[]` for a conforming source. Missing markers are themselves a
 * violation — an absent fence must fail loud, not pass vacuous.
 *
 * The exemption is PURE comment lines only, decided by line shape, never by
 * scanning for a `//` inside the line. An earlier version stripped trailing
 * comments with a quote-aware scanner, and a regex literal containing `//`
 * (`/\/\//`) read as a comment start — everything after it, including a live
 * raw arm, was cut before inspection. A code line that also mentions `/api` in
 * a trailing comment gets flagged too: over-blocking is safe, a cut is a hole.
 */
export function routingSurfaceViolations(src) {
  const lines = src.split("\n");
  const begin = lines.findIndex((l) => l.includes(ROUTING_SURFACE_BEGIN));
  const end = lines.findIndex((l) => l.includes(ROUTING_SURFACE_END));
  if (begin === -1 || end === -1 || end < begin) {
    return [{ line: 0, text: null, reason: "routing-surface-markers-missing" }];
  }
  const out = [];
  lines.forEach((raw, i) => {
    if (i >= begin && i <= end) return;
    if (/^\s*\/\//.test(raw)) return;
    if (raw.includes("/api")) {
      out.push({ line: i + 1, text: raw.trim(), reason: "api-reference-outside-routing-surface" });
    }
  });
  return out;
}
