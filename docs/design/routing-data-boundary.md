# The routing data boundary — a load-bearing invariant

**Status: deliberate, PM-ratified (2026-08-08). Breaking this is a decision,
not a refactor.** This is an as-built note for maintainers of this repository.
It is not part of the consumer contract; nothing in `contract/` depends on it.

## The invariant

**After the route table resolves a row, the raw pathname and the API namespace
prefix are out of scope for everything downstream.** In this codebase that is
implemented more strongly: the runtime's API flow in `app/serve-studio.mjs`
never holds a pathname at all.

- Routing happens in exactly one place: `matchApi()` in `app/verbs.mjs`. It
  receives the raw request URL, constructs the URL object, matches the table,
  and returns **data only**: a table index plus `{ rest, searchParams }`, or
  `{ index: -1, notFound }` where `notFound` is a 404 *body object*.
- **The path-bearing side holds no response authority** (round 6, sdk-qa). An
  earlier shape returned an `execute` closure and took a respond callback — so
  a resolver-internal special case could mint a 200 before the table lookup.
  Now the resolver cannot mint a closure that runs (unknown fields are inert
  downstream), cannot set a status (the miss branch is hardcoded 404 at the
  dispatch site), and cannot reach a handler that is not a row (the executable
  is fetched as `API_ROUTES[m.index]` — table membership is the only door).
- Handlers receive `{ searchParams, verb, rest }` — never a pathname, never a
  URL object. A handler needing path data uses `rest`, which is already scoped
  to its own matched verb.
- `handleRequest` calls `matchApi` and dispatches the indexed row. Neither `u`
  nor `API_PREFIX` is a binding anywhere in that flow.
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
- **`matchApi` and `routeRequest` live in `app/verbs.mjs`, not beside the table.** The grammar
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
- **Resolver-boundary discriminator** (`test/reserved-verbs.test.mjs`): plants
  special cases *inside* `matchApi` and asserts every response channel is dead —
  a minted `{ execute }` is inert and never runs, a minted status loses to the
  hardcoded 404, and nothing a resolver special case does can be enumerated.
- **Property tests on `matchApi`**: with `routes=[]` every API path misses;
  with one route, exactly its matches resolve; the match result carries no
  pathname field and no function-valued field.
- **The literal fence** (`routingSurfaceViolations`): every textual `/api`
  mention in `serve-studio.mjs` lives inside the marked data-only surface.
- **Bypass control**: raw arms planted in the static flow demonstrably cannot
  serve API requests (404), in all the spellings sdk-qa used across rounds.

## The stated residue

The resolver's remaining freedom is exactly its charter: choosing which
declared row a path maps to. A special case written into `matchApi` can
mis-route a path to a *different declared row's* index — the discriminator pins
this blast radius (the served response is a declared row's; nothing new is
enumerated) — but it can never produce a response that is not a declared
row's. A wrong routing decision must be written into the eight-line definition
of routing, where review and the `routes=[]` property test see it.

## If you need to change this

If a future feature genuinely needs path data downstream, extend the match
result (e.g., a richer `rest`) inside `matchApi` — do not reintroduce the
pathname, and never return a function or a status. If you believe the boundary
itself must move, that is a PM-level design change: say so in the commit and
update this note in the same change.
