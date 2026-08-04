# Contract meta — versioning, stability, and how to read this contract

contractVersion: 0.1

This directory IS the openrig studio SDK contract **for building a surface**. If
you are a coding agent building one: read the four core documents below plus
`surface-row.schema.json`, then build. Nothing outside this directory and the
running runtime is required to write a surface that loads in the shell.

**Installing and running an APP is a wider job than writing a surface**, and it
is described in `app-manifest.md` plus `app-manifest.schema.json`. An app that
brings its own backend needs a way to declare that backend, the directories it
reads, the processes it depends on and the verbs it calls; that shape is now
contract, field by field, with stability marks like everything else here.

**It is specified ahead of the tools in two places, and those are named rather
than left to be discovered** — see *Conformance* at the bottom of
`app-manifest.md` for exactly which parts `tools/` implements today and how the
transition converges. A contract that overstates its own implementation is the
defect this document was written to stop repeating: it previously claimed
nothing outside this directory was required, which was true when the SDK only
served surfaces and false the moment apps had backends.

## The documents

Building a **surface** needs the first four. The rest are read when you need what
they describe, and a surface that needs none of them is not missing anything:
shipping an **app** — a surface plus a backend — needs `app-manifest.md`,
adopting live refresh needs `change-signal.md`, and reporting what the user is
looking at needs `focus.md`.

| Document | What it defines |
|---|---|
| `contract-meta.md` (this file) | Version, stability classes, what counts as breaking |
| `manifest.md` | The surface manifest: how a surface registers |
| `shell-protocol.md` | The shell runtime: lifecycle, URL rules, the postMessage API |
| `runtime-api.md` | The HTTP verb set: routes, shapes, failure semantics |
| `app-manifest.md` | Installing an app: `app.json`, `provider.json`, `studio.json` |
| `change-signal.md` | Markers, DATA-vs-CODE refresh, and state that survives a reload |
| `focus.md` | What the user is looking at, and how an agent reads it |
| `drive.md` | How an agent operates a surface the user already has open |

Two schemas sit beside them: `surface-row.schema.json` for a manifest row, and
`app-manifest.schema.json` for `app.json`.

## Discovering the contract at runtime

`GET /api/contract` returns:

```json
{
  "contractVersion": "0.1",
  "runtime": { "name": "openrig-studio", "flavor": "reference-fixture", "boot": "<opaque id, stable for this process>" },
  "capabilities": ["contract.meta", "observe.factory-state", "stream.events", "files.read", "shell.protocol"],
  "manifest": {
    "ok": true, "errors": [], "warnings": [], "surfaces": 1,
    "seats": { "count": 1, "source": "package", "attachable": false },
    "state": "ok",
    "lastLoadedAt": "<ISO timestamp of the last successful load>",
    "reloads": 1,
    "recoveries": 0,
    "lastRecoveryAt": null,
    "integrityReloads": 0,
    "lastIntegrityReloadAt": null,
    "consumer": null
  }
}
```

- `contractVersion` — the version of this contract the runtime implements.
- `capabilities` — which contract namespaces this runtime serves. Check before use.
- `runtime.boot` — an opaque id, **stable for the life of this process and different
  after a restart**. It is how a surface knows its own CODE changed: a studio copies
  surfaces into its runtime directory at boot, so edited source only reaches the
  browser after a restart. Watching a file announces a change the page cannot yet
  see; watching this announces the moment new code became servable. Latch it on your
  FIRST reading, successful or not, and reload when it CHANGES. See
  `change-signal.md`.
- `manifest` — the live validation report for `surfaces.json` (see `manifest.md`).
  `surfaces` is the count of valid rows currently served; it changes as the
  manifest changes.

`manifest.consumer` is `null` above because that example is a zero-config
runtime. With an overlay configured, `manifest.consumer` is populated:

```json
{
  "dir": "<the overlay directory this runtime resolved, absolute>",
  "surfaces": 1,
  "state": "ok",
  "lastLoadedAt": "<ISO timestamp of the last successful load>",
  "reloads": 1,
  "recoveries": 0,
  "lastRecoveryAt": null,
  "integrityReloads": 0,
  "lastIntegrityReloadAt": null
}
```

Field semantics are in `manifest.md`. The block is shown here as well as
described there because the shape is what a caller matches on, and a shape
documented only in prose is a shape nothing can check: this example is asserted
against a live overlay-configured runtime by the suite, so a field added to or
removed from that block fails a test rather than shipping unpromised. That is not
hypothetical — `dir` shipped, was asserted by two tests, and was documented
nowhere, because the drift guard compared only the TOP-LEVEL `manifest` keys
against an example whose `consumer` was `null`.

This endpoint is the first thing to read against a live runtime.

## Stability classes

Every route, field, and message type in this contract carries one of:

- **stable** — changes only additively while the contract is 0.x. Removal or
  rename requires a major version bump with a deprecation note.
- **provisional** — may change with a minor bump. Usable, but re-check on
  version changes. Marked in-line wherever it appears.
- **runtime-internal** — exists in a runtime but is NOT contract. Do not build
  on it. Listed in `runtime-api.md` so you are warned at the point of
  temptation.

## What counts as a breaking change

- Removing or renaming a route, response field, manifest field, or postMessage type.
- Changing a response shape non-additively.
- Changing an error or conflict contract.
- Changing URL-resolution or surface-lifecycle semantics.

Additive fields and new routes are non-breaking. Breaking changes move
`contractVersion` and are named in a changelog entry.

## How a surface should decide compatibility

Check two things at boot, in this order:

1. **Capabilities**: every namespace you use appears in `capabilities`. A
   missing capability means this runtime cannot serve you — fail with a
   visible message.
2. **Version**: parse `contractVersion` as `major.minor`. Within the same
   major version, minor bumps are additive for **stable**-marked items — a
   surface built on stable items of 0.1 keeps working on 0.2. A **major**
   change may break you: fail visibly rather than guessing.

Exact-match checks (`contractVersion !== "0.1"`) are safe but over-strict:
they refuse runtimes that are contractually guaranteed to work. Prefer
same-major + capabilities-present. Surfaces using **provisional** items
should re-check them on any version change, including minor.

## Design stance (why this contract is shaped this way)

- **This contract is the boundary.** The runtime may internally consult other
  systems; surfaces talk only to this API. Anything a surface needs from the
  wider system arrives through a versioned verb here — never by reaching
  around the runtime. A surface that routes around the boundary is out of
  contract by definition.
- **Declared-independent.** The shapes here are designed and owned by this
  contract; they are not mirrors of any other system's API. Backing systems
  can change without this contract changing.
- **Honest failure.** When something is wrong it must look wrong: degraded
  states are named in responses, malformed manifests are reported at
  `/api/contract`, and nothing silently pretends health.
- **No credential ever appears in a contract response.** Auth state, tokens,
  key paths, fingerprints — none of it crosses this boundary.
