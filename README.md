# openrig studio

An SDK for building agent-driven mini-apps: a thin browser surface paired
with an agent, running in a shared shell. Point your coding agent at this
repository and it can build you a surface.

## Quickstart

Requires Node 18+. No dependencies, no build step.

```sh
node app/serve-studio.mjs
```

Open http://127.0.0.1:8890/ — the shell. It starts with one surface on the rail, FLOOR, rendering the fixture rig state. Flags: `--port <n>`, `--fixtures <dir>`.

## Where everything is

| Path | What it is |
|---|---|
| `contract/` | **The contract — start here.** Four documents + the manifest row schema. |
| `create-studio/` | The scaffolder: generates a working surface project. |
| `app/serve-studio.mjs` | The reference runtime (zero-dependency Node HTTP server). |
| `app/shell.html` | The shell: rail + stage + agent sidebar. |
| `app/surfaces.json` | The surface manifest the shell renders. |
| `app/surfaces/` | Surface pages live here, served at `/surfaces/…`. |
| `fixtures/` | The data behind the runtime's API verbs (rig floor state, files root). |

## Starting a new surface

The scaffolder emits a working surface project — page, schema-valid manifest
row, and instructions — already wired to contract v0.1:

```sh
node create-studio/index.mjs my-surface
```

The intended public form is `npm create @openrig/studio my-surface`, which npm
resolves to `@openrig/create-studio`. **That command is not available yet** —
the package is unpublished and its final name is a deferred decision. Until
then use the invocation above. See `create-studio/README.md`.

## Building a surface

Read `contract/contract-meta.md` first — it explains how to read the rest of
the contract. Then: `contract/manifest.md` shows how a surface registers,
`contract/shell-protocol.md` what the shell provides, and
`contract/runtime-api.md` the HTTP verbs and their exact shapes. A running
runtime self-describes at `GET /api/contract`.

The reference runtime is fixture-backed: its API verbs serve data from
`fixtures/`, so everything works on any machine with no external processes.
Editing a fixture file fires the change-signal stream — a convenient way to
watch a live-updating surface work.

## Status

Contract v0.1. Pre-release.
