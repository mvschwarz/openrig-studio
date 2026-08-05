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
| `contract/` | **The contract — start here.** `contract-meta.md` indexes the rest, including the three agent primitives and the manifest row schema. |
| `skills/building-studio-apps/` | **If you are a coding agent, load this first.** Orientation plus the failure modes, written for this job. |
| `create-studio/` | The scaffolder: generates a working surface project. |
| `app/serve-studio.mjs` | The reference runtime (zero-dependency Node HTTP server). |
| `app/shell.html` | The shell: rail + stage + agent sidebar. |
| `app/surfaces.json` | The surface manifest the shell renders. |
| `app/surfaces/` | Surface pages live here, served at `/surfaces/…`. |
| `fixtures/` | The data behind the runtime's API verbs (rig floor state, files root). |
| `apps/` | Apps bundled with the SDK. An **app** is a surface plus whatever backend it needs — see `contract/app-manifest.md`. Most apps live in their own repositories; the ones here ship with the SDK because they exercise a primitive it defines. |
| `providers/` | The backends those bundled apps call. A provider declares how to run itself and which verbs it answers; nothing in `app/` depends on one. |

**The SDK is still a shell and a contract, not a framework you import.** A bundled
app is an app like any other — it registers a row and calls verbs, with no
privileged access to the runtime. It is here so that a primitive the contract
defines has a real consumer in the same repository, which is the thing the
conformance tables kept having to say "no" about.

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
that survives a reload. If you want an agent to know what the user is looking at,
`contract/focus.md` covers the record, the verb that reads it, and addressing
state inside a surface. If you want an agent to **operate** your surface,
`contract/drive.md` covers ops, the generation counter, and what a surface does
with intent it has not seen. All three are opt-in, and a surface that skips them
is unaffected. A running runtime self-describes at `GET /api/contract`.

The reference runtime is fixture-backed: its API verbs serve data from
`fixtures/`, so everything works on any machine with no external processes.
Editing a fixture file fires the change-signal stream — a convenient way to
watch a live-updating surface work.

## Status

Package 0.8.0. Contract v0.1 — unchanged, because everything below is additive
or a behaviour fix, and the contract version only moves on a breaking change.
Pre-release.

**All three agent primitives are in the SDK**, and a human and an agent can now
mark up the same screen. An agent can see what changed, see what the user is
looking at, operate the surface they have open, and point at the part of it that
is wrong.

### What is new in 0.8.0

**Annotations.** A human or an agent can draw on a surface and say what should
change — circle, box, arrow, text, with the two authors rendered differently
because who marked something is part of what it means.

**The shell draws them, over the stage.** That is the design decision the rest
follows from: a feature that required surfaces to cooperate would work on none of
the surfaces that already exist, which is the population that matters. A surface
written before this release is annotatable and needs no change.

Three optional messages exist for surfaces that want to be *more* correct, and a
surface that sends none of them still gets a working board:

- A surface holding several documents behind one id can say which board it is
  showing, so marks drawn on one page do not hang over another.
- A surface that renders its real content in a same-origin nested frame can name
  that frame, so an agent naming an element anchors to the document the human is
  looking at rather than to the surface's own chrome.
- A surface that moves something can ask for a re-measure. An element that *moves*
  changes no size and no scroll, so nothing else fires — the mark would sit at the
  old geometry still reporting itself anchored.

**An anchor that loses its element says so.** It is drawn dashed and badged rather
than quietly relocated to whatever now occupies that space, because a mark that
slides is worse than one that admits it lost its target.

Marks are held in memory unless the runtime is started with `--annotations <file>`,
and the board says **"session only"** rather than "persisted" when nothing is
storing them. See `contract/annotations.md`.

**Also:** a failing provider install during provisioning now prints what npm said.
It ran under `--silent`, which suppresses errors as well as progress, so a failure
aborted the install with no text to act on.

### What is new in 0.7.1

**`GET /api/contract` now advertises focus and drive.** Both verbs worked and
neither appeared in `capabilities` — so an agent doing feature detection the way
`contract-meta.md` instructs concluded the features were absent. A verb that
answers without advertising is worse than a missing one: the consumer follows the
documented path and is steered to the wrong answer. Found by an independent cold
build, which is the only way this class gets found.

`POST /api/focus`'s response shape is now documented, and the generated project's
final run snippet no longer omits `--surfaces` — without it the new surface never
reaches the rail, which looks like a broken row rather than a missing flag.

### What is new in 0.7.0

Someone built a small app against 0.6.0 from the documentation alone, and fixed
what that turned up.

**A drive op posted before a surface loaded is no longer replayed when it loads.**
The runtime keeps the last op, so a page that had never seen one treated it as
new — meaning a reload re-ran it and a second tab ran it again. Harmless for
`select`; a side effect nobody asked for if the op is `play` or `export`. A
surface now adopts the current generation as a baseline on its first poll, and
`resumeLatestOnLoad: true` opts back in. This is a behaviour change to a shipped
primitive, which is why it is a minor rather than a patch.

**The way in was the real problem.** The skill an agent is told to load first
never mentioned the three primitives at all — it now leads with them. The project
the scaffolder generates documents them too, including the two already wired into
the page it emits.

**Docs no longer state the package version**, because a version in prose is wrong
at the next release; they point at the package instead. A guard enforces it. Also
noted where it belongs: `networkidle` never settles against a studio, because the
event stream stays open for the life of the page.

### What arrived in 0.6.0

**Agent-drives-the-app.** The third primitive, and the one that changes what an
agent is: it can now operate the surface the user already has open instead of
describing what should happen next. An agent `POST`s an **op** carrying intent,
the open page follows, and a line of narration rides along so a watcher sees a
narrated change rather than controls twitching by themselves.

Two properties carry the design. It is a **generation counter, not a queue** — the
surface applies the newest op and discards everything superseded, because a queue
lets a slow page fall behind and then act on instructions that were true minutes
ago, looking perfectly healthy the whole time. And an op is **opaque intent, never
DOM operations**: "show take 3", not "click the third button". A driver that
reached into markup would break on any re-layout and would force every drivable
surface to freeze its DOM as an interface it never agreed to publish.

**Every scaffolded surface is drivable the moment it is generated** — the channel
is only worth shipping if surfaces actually adopt it, and the scaffolder is where
that happens once for everyone rather than app by app.

See `contract/drive.md`.

### What arrived in 0.5.0

**The change signal.** A surface can stay fresh without losing what the user was
doing. The runtime mints an opaque, monotonic **marker**; a consumer polls it with
`?since=` and compares only for equality. The marker is the contract and the
transport is not — `/api/events` is an optional accelerant and a surface that only
polls is fully conformant. A **code** change is keyed on the runtime's process
identity (`runtime.boot`) rather than a file timestamp, because a studio copies
surfaces at boot and an edited source file has not reached the browser until a
restart.

State that survives the reload is **declared, not hand-rolled**: a surface row
carries `preserve: [...]` naming what to keep, and the runtime's helper does the
capturing and restoring. The app says what, not how. The standard adapter binds
`scroll`, `form` and `playhead` to real DOM, verified in a browser by a reviewer
who did not write it. When the signal is unhealthy the surface **says so** instead
of showing stale data that still looks live. `create-studio` emits all of this, so
a new surface inherits it rather than reimplementing it.

**Focus — what the user is looking at.** `GET /api/focus` answers the same
change-signal shape, so an agent polls it with the primitive it already has. The
read is the point: the record existed before this release and nothing off the box
could get at it, so consumers opened the file directly. A write updates the fields
it **names** and leaves the rest, because whole-record replacement was a measured
defect — one writer blanked the view context another had just set. `selection` is
carried as its own surface means it, with no universal schema imposed, and the
record names the surface so a consumer that does not understand a given selection
can say so rather than misread it. `readAddress` / `writeAddress` put a surface's
own state in the URL hash — the shell owns the query, the surface owns the hash —
so a link restores a view instead of merely describing one.

**What these two do NOT promise**, taken from the conformance tables rather than
summarised more kindly:

- **Playback `resume` is not guaranteed, and not on first visit.** Browsers gate
  programmatic `play()` behind their autoplay policy. The position is restored and
  the clip stays paused under the default policy. Muting to win the policy check is
  explicitly not the answer — it trades one broken promise for another.
- **Restoring before first paint holds only when the restore is called from a
  deferred module script.** It is a property of the call site, not of the adapter.
- **The standard adapter does not handle `selection`, by decision.** It means four
  different things across real applications; a generic adapter would be right for
  one and silently wrong for the rest, so the declaring surface supplies that kind.
- **`by` is caller-declared here.** The reference runtime is single-process and
  loopback and has no identity for its caller. A runtime that has one MUST override
  it — do not build a trust decision on `by` without knowing which produced it.
- **No surface in this repository addresses its own state yet.** None has view
  state worth addressing; the shell hosts and the starter renders a fixture. The
  helper is contract and tested, and the first real application is what will
  exercise it.

### What arrived in 0.4.0

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

### What is NOT in 0.7.0

**A surface refusing an op it cannot honour, and saying why.** An agent will ask
for things a surface cannot do right now — sound a browser will not grant without a
click, a file that has been moved. A bare rejection is useless to a driver; a
refusal has to carry the current state so the agent can decide what to do instead.
That shape is not specified yet, deliberately: invented before a real application
needs one, it would be the wrong shape, and a half-specified refusal is harder to
correct than an absent one because drivers build on it.

Until it exists, a driver learns what happened by **observing the surface** — read
`/api/focus` back, or watch whatever the surface reports — rather than by trusting
that a `200` on the op means the thing occurred. Accepting an op and honouring it
are two different claims, and today only the first one is answered.

**A rich vocabulary in the starter.** The scaffolded surface honours `say`,
`refresh` and `reload`, because those are what it can actually do. A starter
advertising more would report success for things it does not perform, which is
worse than offering less. Real vocabularies belong to real surfaces.

**The SDK's own FLOOR surface is not drivable**, and neither is the shell. They
render fixture state and have nothing worth driving; the drivable surface this
repository ships is the one the scaffolder emits.
