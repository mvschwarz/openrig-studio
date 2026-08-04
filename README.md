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
| `contract/` | **The contract — start here.** Four core documents, two more for apps and live refresh, plus the manifest row schema. |
| `skills/building-studio-apps/` | **If you are a coding agent, load this first.** Orientation plus the failure modes, written for this job. |
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

**If you are a coding agent, load `skills/building-studio-apps` first.** It is
written for exactly this job and it leads with the decision that shapes
everything — whether your app needs a server of its own — then the failure modes
that are hard to diagnose from the contract alone: a surface that loads but whose
panes stay empty, a tab that 404s or shows another project's data, an app that
works on the machine that built it and fails on a fresh install.

**The contract is the authority; the skill is the fast path into it.** Where they
appear to disagree, the contract wins and the skill has a bug.

Read `contract/contract-meta.md` first — it explains how to read the rest of
the contract. Then: `contract/manifest.md` shows how a surface registers,
`contract/shell-protocol.md` what the shell provides, and
`contract/runtime-api.md` the HTTP verbs and their exact shapes. If you want the
surface to stay fresh without losing the user's work, `contract/change-signal.md`
covers markers, the difference between data changing and code changing, and state
that survives a reload — it is opt-in, and a surface that skips it is unaffected.
A running runtime self-describes at `GET /api/contract`.

The reference runtime is fixture-backed: its API verbs serve data from
`fixtures/`, so everything works on any machine with no external processes.
Editing a fixture file fires the change-signal stream — a convenient way to
watch a live-updating surface work.

## Status

Package 0.4.0. Contract v0.1 — unchanged, because everything below is additive
or a behaviour fix, and the contract version only moves on a breaking change.
Pre-release.

### What is in 0.4.0

**The agent panel is real.** Its roster is the rig this studio belongs to, not
every seat on the machine, and a studio may declare its own roster instead — an
empty declaration included, which means "this studio ships without seats" rather
than "nothing was configured". A studio with no rig shows an honest empty panel;
it no longer falls through to the SDK's own example seat. Seats carry their
status, so a configured agent that is not running stays visible instead of the
panel silently shrinking.

**Terminal attach is authorized against the roster the shell is actually served**
— the same file, not a second lookup that ought to agree. The seat name in the
URL is caller-controlled, so a narrowed sidebar was never the boundary.

**`GET /api/contract` documents `manifest.consumer` field by field**, including
`dir`, which is what tells one studio from another on a box running several. The
drift guard now descends into that block, so a field cannot ship there
undocumented again.

**Provisioning** reuses a studio only when it is the one this run installed,
refuses a port held by anything else rather than verifying against a stranger,
survives a host where `systemctl` exists but no user manager is reachable, and
binds the root kinds an app actually declared.

### What is NOT in 0.4.0

**The three agent primitives are not in the SDK yet:**

- **focus** — the agent seeing what the user is looking at
- **agent-drives-the-app** — the agent operating the surface
- **minimal-refresh** — the surface updating without the user noticing

Working versions of all three exist in applications built on this SDK, which is
not the same as the SDK offering them. Until they land here, an app that wants
them builds them itself, and two apps will do it differently. That is the gap
this line exists to name.
