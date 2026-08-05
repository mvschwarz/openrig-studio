# The runtime API — HTTP verbs, shapes, failure semantics

contractVersion: 0.1

Base: the runtime's own origin (default `http://127.0.0.1:8890`). All routes
are GET unless noted. Start every integration by reading `GET /api/contract`
(shape in `contract-meta.md`) and checking `capabilities`.

## Who may answer a verb (stable)

**The documented shape binds whoever serves it.** In a studio running apps, a
provider may implement a verb documented here — that is expected, not a
workaround: in a real install the files verbs are served by something that knows
about real directories rather than the reference runtime's fixtures. **What a
provider may not do is answer a documented name with an undocumented shape.**

So a surface may rely on the shape without knowing who produced it, which is the
only thing that makes these verbs worth documenting. A provider that wants to
answer a different question **gives it a different name** — new names in the same
namespace are the provider's own and need no permission. Shadowing a documented
name with a different answer is the one move that is out of bounds, because it
turns a contract into a coin flip decided by what happens to be installed.

Three verbs cannot be substituted at all, and it is worth knowing why they are
different in kind rather than more important: `GET /api/contract`,
`GET /api/events` and `GET /api/factory/state` are the runtime **describing
itself**. Nothing else can answer them, so nothing else may.

**Measured, not theoretical.** A provider once answered zero-argument
`/api/files/tree` with a list of bound roots instead of a directory's contents —
a reasonable answer to a different question, since it had several roots and the
reference runtime has one. Every consumer then had to handle both, which is the
cost this rule exists to prevent.

## Failure semantics (stable)

- **Degraded reads** return HTTP 200 with `{ "ok": false, "degraded": "<why>" }`
  — the runtime is healthy, the backing data is not. Render the degradation;
  do not retry-loop.
- **Client errors** return 4xx with `{ "ok": false, "error": "<what> — <what to do>" }`.
- **Unexpected errors** return 500 with `{ "ok": false, "error": "<message>" }`.
- Unknown `/api/*` paths return 404 with an error naming where the verb set
  is documented.
- No contract response ever contains a credential value, token, key path, or
  fingerprint.

## contract.meta

### `GET /api/contract` — stable
Version, capabilities, and the manifest validation report. Documented in
`contract-meta.md`. Read it first.

## observe

### `GET /api/factory/state` — stable
The rig-floor envelope: who is working and what is queued. The shape is owned
by this contract (declared here, field-by-field), not by any backing system.

```json
{
  "ok": true,
  "rig": "<rig name>",
  "generatedAt": "<ISO timestamp, stamped fresh per read>",
  "seats": [
    { "seat": "<session name>", "pod": "<pod id>", "member": "<member id>",
      "state": "working | idle | blocked | stalled | down",
      "ageMinutes": 0, "hasWork": false, "pendingWork": 0,
      "lifecycle": "<runtime lifecycle string>" }
  ],
  "queue": [
    { "id": "<item id>", "state": "<item state string>",
      "destination": "<session>", "source": "<session>",
      "tags": ["<tag>"], "updated": "<ISO timestamp>", "title": "<one line>" }
  ]
}
```

- `seats[].state` is a closed set (stable). `queue[].state` is an open string
  set (provisional) — render it, do not switch on it exhaustively.
- `ageMinutes` is **whole minutes elapsed since the seat's most recent
  observed activity** (any runtime-visible action by that seat), rounded to
  the nearest minute, or `null` when no activity timestamp is known. It
  measures quietness, not uptime: a `working` seat can have a nonzero age.
- Degraded shape: `{ "ok": false, "degraded": "<why>", "rig": null, "seats": [], "queue": [] }`.

## stream

### `GET /api/events` — stable (as a signal)
Server-sent events. **Signal-only contract**: any received message means
"state changed — re-fetch via the observe/files verbs." Event payload
contents are unspecified in v0.1 and must not be parsed or switched on.

- **Event naming (closed set):** every change signal is a **default, unnamed
  `message` event** — an `EventSource.onmessage` handler receives all of
  them. The **only** named event in v0.1 is `degraded`. Stable runtimes will
  not introduce additional named events within 0.x; a new named event is a
  contract addition and arrives with a version change.
- Comment frames (lines starting `:`) are keepalives; EventSource ignores
  them natively.
- A `degraded` named event means the signal source is unhealthy: close and
  fall back to polling (cadence guidance in `shell-protocol.md`).
- Reconnection is EventSource-native. Delivery is at-least-once-ish with no
  replay guarantee: after any reconnect, re-fetch once rather than assuming
  you missed nothing.
- **AUTOMATING A STUDIO: `networkidle` NEVER SETTLES.** This stream stays open
  for the life of the page, so any browser-automation wait that requires an idle
  network — Playwright's `waitForLoadState("networkidle")` and its equivalents —
  times out on every single page load. It is the most common wait there is, and
  the symptom reads as a slow or broken studio rather than as a wait that cannot
  succeed here. **Wait for an element, or for `domcontentloaded`, instead.** The
  same applies to headless captures that settle on network quiet.

## files (read-only)

All paths are pinned inside the runtime's files root; anything outside it is
refused with a 4xx naming the pin. There are no write verbs in this contract.

### `GET /api/files/tree?dir=<abs path>` — stable
Without `dir`: the root listing. With `dir` (inside the root):
`{ "ok": true, "path": "...", "dirs": [{name, path}], "files": [{name, path, size, mtime, kind}] }`.
`kind` ∈ `image | video | audio | markdown | html | text | other`.

### `GET /api/files/read?path=<abs path>` — stable
Text-like files: `{ "ok": true, "kind": "...", "content": "<utf8>", "mtime": <ms> }`.
Binary/media files: `{ "ok": true, "kind": "...", "raw": "/api/files/raw?path=...", "mtime": <ms> }` —
fetch the `raw` URL for bytes.

### `GET /api/files/raw?path=<abs path>` — stable
The file's bytes with a best-effort content-type.

### `GET /api/files/search?q=<term>` — stable
Case-insensitive filename search under the root:
`{ "ok": true, "hits": [{name, path, kind}] }`. Bounded result count; queries
under 2 characters return empty hits.

## annotations

Marks drawn over a surface by a human or an agent. Full semantics — the record,
the sub-context, and what the shell composes — are in `annotations.md`; this is
the verb shape.

### `GET /api/annotations?scope=<key>` — stable
`{ "ok": true, "scope": "<key>", "records": [ … ] }`.

**Without `scope` this answers an empty set, not every scope on the box.** A
caller that forgot the parameter would otherwise be handed another surface's marks
and render them over this one.

### `POST /api/annotations` — stable
Body `{ scope, records }`; answers `{ ok, scope, records }`. Replaces the whole
set for that scope. A write naming no scope, or carrying no `records` array, is
refused with 400 naming which.

**Substitutable, like the files verbs.** These answer stored marks — data on the
box — not the runtime describing itself, so a provider that knows where a real
studio keeps annotations should serve them under this shape.

## runtime-internal — exists in some runtimes; DO NOT build on

Listed so you are warned at the point of temptation. None of these are
contract, none are present in the reference runtime's public surface, and
each becomes contract only through its own future security/ownership gate:

- files mutation (write / goto / roots overlays)
- shell sidebar-arrangement persistence
- typing text into an agent seat or terminal
- OAuth / credential-connect flows
- any verb that reaches a backing system's API directly

If your surface needs one of these, it needs a contract version that includes
it — not a workaround.

**Credential flows are the exception to that sentence: they are not waiting on a
gate, they are OUT OF SCOPE FOR THIS SDK.** Ruled 2026-08-04. The test is
audience: using this SDK already implies you can sign in to your own tools, so a
subscription-login flow serves a different audience than the one holding this
contract, and it belongs to the product that has that audience rather than here.

This is a **deliberate property, not a gap**: the reference runtime handles no
credentials, stores none, and has nowhere to put one. Anything that would give it
somewhere — a token store, a callback route, a secret in a manifest — is a change
of character rather than an addition, and does not arrive through a version bump.
