# The routing data boundary — a load-bearing invariant

**Status: deliberate, PM-ratified (2026-08-08). Breaking this is a decision,
not a refactor.** This is an as-built note for maintainers of this repository.
It is not part of the consumer contract; nothing in `contract/` depends on it.

## The invariant

**After the route table resolves a row, the raw pathname and the API namespace
prefix are out of scope for everything downstream.** In this codebase that is
implemented more strongly: the runtime's API flow in `app/serve-studio.mjs`
never holds a pathname at all.

- Routing happens in exactly one place: `resolveApi()` in `app/verbs.mjs`. It
  receives the raw request URL, constructs the URL object, matches the table,
  and returns an `execute` closure.
- Handlers receive `{ searchParams, verb, rest }` — never a pathname, never a
  URL object. A handler needing path data uses `rest`, which is already scoped
  to its own matched verb.
- `handleRequest` calls `resolveApi` and executes the result. Neither `u` nor
  `API_PREFIX` is a binding anywhere in that flow.
- The static-file flow's `const u = new URL(...)` is constructed **after** the
  API branch has returned. That ordering is load-bearing: it is what guarantees
  no code that can see an API request ever holds a pathname.

## Why it exists

Five review rounds of one defect: a route serving without being enumerated or
classified (public 404 / internal 200 while `/api/contract` advertised the
capability). Each of four fixes defined a *trusted region* — a spelling
denylist, a registration wrapper, a fenced file region, a dispatcher body — and
the next raw arm was simply written inside the newest region. A trusted region
is always one special-case away from wrong.

The data boundary ends the series because it removes the material, not the
place: a pathname special-case downstream of routing **cannot be written** —
there is no pathname there to branch on. The claim "a route cannot serve
without a row" is a fact about the data flow, not a promise a guard checks.

## What looks arbitrary but is not

- **`const u = new URL(...)` sits after the API branch.** Hoisting it to the
  top of `handleRequest` "for tidiness" re-introduces a pathname binding that
  is live while API requests are in flight — the exact material of the round-5
  finding. The unwritability control in `test/reserved-verbs.test.mjs` will
  fail if you do this.
- **Handlers take `request`, not `u`.** Widening the handler signature to pass
  the URL object hands every handler a pathname again.
- **`resolveApi` lives in `app/verbs.mjs`, not beside the table.** The grammar
  module is the routing definition; a special case must be written into the
  definition of routing itself, where the `routes=[]` property test and review
  can see it.

## The guards that police the residue

None of these *create* the property — the structure does. They detect attempts
to remove it:

- **Unwritability control** (`test/reserved-verbs.test.mjs`): plants sdk-qa's
  round-4 literal arm and round-5 derived-prefix arm at the top of the API flow
  and asserts each detonates as a `ReferenceError` naming the absent binding —
  and above all, never serves.
- **Property tests on `resolveApi`**: with `routes=[]` every API path misses;
  with one route, exactly its matches resolve; the resolved request carries no
  pathname field.
- **The literal fence** (`routingSurfaceViolations`): every textual `/api`
  mention in `serve-studio.mjs` lives inside the marked data-only surface.
- **Bypass control**: raw arms planted in the static flow demonstrably cannot
  serve API requests (404), in all the spellings sdk-qa used across rounds.

## If you need to change this

If a future feature genuinely needs path data downstream, extend the resolved
`request` (e.g., a richer `rest`) inside `resolveApi` — do not reintroduce the
pathname. If you believe the boundary itself must move, that is a PM-level
design change: say so in the commit and update this note in the same change.
