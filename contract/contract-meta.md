# Contract meta — versioning, stability, and how to read this contract

contractVersion: 0.1

This directory IS the openrig studio SDK contract. If you are a coding agent
building a surface: read these four documents plus `surface-row.schema.json`,
then build. Nothing outside this directory and the running runtime is required.

## The four documents

| Document | What it defines |
|---|---|
| `contract-meta.md` (this file) | Version, stability classes, what counts as breaking |
| `manifest.md` | The surface manifest: how a surface registers |
| `shell-protocol.md` | The shell runtime: lifecycle, URL rules, the postMessage API |
| `runtime-api.md` | The HTTP verb set: routes, shapes, failure semantics |

## Discovering the contract at runtime

`GET /api/contract` returns:

```json
{
  "contractVersion": "0.1",
  "runtime": { "name": "openrig-studio", "flavor": "reference-fixture" },
  "capabilities": ["contract.meta", "observe.factory-state", "stream.events", "files.read", "shell.protocol"],
  "manifest": {
    "ok": true, "errors": [], "warnings": [], "surfaces": 1,
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
- `manifest` — the live validation report for `surfaces.json` (see `manifest.md`).
  `surfaces` is the count of valid rows currently served; it changes as the
  manifest changes.

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
