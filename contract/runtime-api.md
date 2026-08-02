# The runtime API — HTTP verbs, shapes, failure semantics

contractVersion: 0.1

Base: the runtime's own origin (default `http://127.0.0.1:8890`). All routes
are GET unless noted. Start every integration by reading `GET /api/contract`
(shape in `contract-meta.md`) and checking `capabilities`.

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
