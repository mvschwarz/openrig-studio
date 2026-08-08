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

/**
 * Every `/api/` route a runtime source actually serves, in EVERY form it can be
 * written.
 *
 * **DISCOVERY IS THE STAGE THAT MATTERS AND IT WAS THE STAGE NOT UNDER TEST.** The
 * scanner recognised only `u.pathname === "/api/x"`. A live route written
 * `u.pathname.startsWith("/api/x/")` was INVISIBLE: it answered 200 while the
 * classification suite passed, because a route the scanner cannot see is a route
 * the classifier is never asked about.
 *
 * Shared with the test rather than written there, so the thing under test and the
 * thing that runs are the same function.
 */
export function discoverApiRoutes(src) {
  const exact = [...src.matchAll(/u\.pathname === "(\/api\/[^"]+)"/g)].map((m) => m[1]);
  const prefix = [...src.matchAll(/u\.pathname\.startsWith\("(\/api\/[^"]+)"\)/g)].map((m) => m[1]);
  // `/api/` itself is the catch-all 404 arm, not a served verb.
  return [...new Set([...exact, ...prefix])].filter((r) => r !== "/api/");
}
