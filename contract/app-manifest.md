# Installing an app — the manifest contract

contractVersion: 0.1

`manifest.md` covers registering a **surface**: a page that loads in the shell.
This document covers installing an **app**: a surface *plus* the backend it
calls, the directories it reads, the processes it depends on, and the binaries
it needs. An app that brings a backend cannot be installed from a surface row
alone, and until now the shape that carries the rest was undocumented.

Three files, three owners, and the split is the whole design:

| file | owner | says |
|---|---|---|
| `app.json` | the app | what this app IS and what it NEEDS |
| `provider.json` | the provider package | how to RUN this backend and what it ANSWERS |
| `studio.json` | the box | which apps are on, and where this machine keeps things |

## The rule that decides where a field goes

**A fact belongs to the thing that knows it.**

The provider knows how to start itself and which verbs it answers. The app knows
which verbs it calls and which kinds of directory it needs. The box knows where
those directories actually are. When a fact is written down twice, the copies
drift — and a drifted copy is not a cosmetic problem: a capability every surface
depended on was deleted from this studio by removing an app that happened to be
the only one declaring it.

Its corollary, applied throughout: **if the system can already work a fact out
from something declared elsewhere, do not declare it again.** A second
declaration is a copy. Where the system *cannot* work it out, declare it — an
inferred value that is wrong is unappealable, because there is no field in which
to disagree with it.

---

## `provider.json` — what a backend is

Lives at `providers/<package>/provider.json`. The provider is authoritative
about itself; an app may not override any of this.

```json
{
  "package": "@openrig/studio-cutdown",
  "run": {
    "entry": "cutdown-server.mjs",
    "args": ["--port", "{{port}}", "--footage", "{{root:footage}}"],
    "env": { "CUTDOWN_API": "http://127.0.0.1:{{port}}" },
    "companions": [
      { "label": "cut lane", "entry": "watch-markers.mjs",
        "args": ["--footage", "{{root:footage}}"] }
    ]
  },
  "serves": ["/media/", "/cutprev/", "/cuts/"],
  "verbs": ["/api/clips", "/api/cuts", "/api/export-status/"],
  "supplies": ["ffmpeg", "ffprobe"]
}
```

| field | stability | meaning |
|---|---|---|
| `package` | stable | the name apps reference |
| `run.entry` | stable | the file to start, relative to the provider directory |
| `run.args` | stable | argv, after template substitution below |
| `run.env` | stable | environment, values templated the same way |
| `run.companions[]` | stable | long-running processes started **with** the provider |
| `serves[]` | stable | **byte-route prefixes**, matched by prefix |
| `verbs[]` | stable | the `/api/` verbs this provider ANSWERS |
| `supplies[]` | provisional | binaries this package ships, so the host need not have them |

**`serves` and `verbs` are two different routing tables and must not be merged.**
`serves` entries are byte routes matched by prefix — `/media/` catches
`/media/clip.mp4`. `verbs` are `/api/` routes matched exactly, *except* that a
verb ending in `/` is a prefix, so `/api/export-status/` matches
`/api/export-status/<jobId>` while `/api/health` matches only itself. Keeping
them separate is deliberate: a backend is not only its API, and a studio that
proxies only `/api/*` lists media that will not play.

**Companions are a requirement, not a convenience.** Some verbs only *accept*
work; the thing that performs it is a separate long-running process. Declaring a
companion is how the box knows to start it. A verb whose performer is not
running accepts work nothing will ever do — the write returns success, the data
changes on disk, and only the product is inert. A declared companion whose file
is absent is refused by name rather than skipped.

---

## `app.json` — what an app is and needs

```json
{
  "manifest_version": 1,
  "id": "cutdown",
  "name": "CUTDOWN",
  "summary": "Punch in/out on a folder of footage and let the lane render the cuts.",
  "category": "create",
  "maker": { "name": "OpenRig", "url": "https://github.com/example" },

  "surface": {
    "entry": "app/cutdown.html",
    "path": "/surfaces/cutdown.html",
    "glyph": "✂",
    "hint": "pick and trim takes"
  },

  "provider": { "package": "@openrig/studio-cutdown", "required": true },

  "roots": {
    "footage": { "required": true },
    "project": { "required": true }
  },

  "calls": {
    "/api/clips":  { "required": true },
    "/api/focus":  { "required": false }
  },

  "vendor": ["tldraw-v5.2.5"],

  "requires": {
    "binaries": ["ffmpeg", "ffprobe"],
    "ffmpeg_filters": ["scale", "concat"],
    "ffmpeg_filters_preferred": ["drawtext"]
  }
}
```

### Identity and presentation

| field | stability | meaning |
|---|---|---|
| `manifest_version` | stable | `1`. Bumped only for a breaking manifest change. |
| `id` | stable | unique; becomes the surface row id |
| `name` | stable | rail label |
| `summary` | stable | one line, for listings |
| `category` | provisional | grouping hint (`create` / `build` / `grow` / `system`) |
| `maker` | provisional | `{ name, url }` — attribution, not resolution |

### `surface` — where the page comes from

| field | stability | meaning |
|---|---|---|
| `surface.entry` | stable | where the file lives in YOUR repo |
| `surface.path` | stable | where it is served on the rail |
| `surface.url` | provisional | for an app that serves itself; mutually exclusive with `path` |
| `surface.glyph` | stable | one character |
| `surface.hint` | stable | rail tooltip |

`entry` and `path` are different things and conflating them is the common slip:
the composer copies `entry` into the overlay and serves it at `path`. An app
with `url` has no `entry` to copy — something else already serves it.

### `provider` — a REFERENCE, not a run spec

| field | stability | meaning |
|---|---|---|
| `provider.package` | stable | the backend this app is a client of |
| `provider.required` | stable | `true` if the app is useless without it |

**An app does not declare how to start a provider.** It did once, which is how
one provider's start command came to be written in two apps that had already
drifted apart. The provider declares itself; the app names it.

`provider` is singular on purpose: it means *the backend this app is a client
of*, not *everything this app depends on*. Dependencies on other backends are
`calls`.

### `roots` — KINDS, never paths

```json
"roots": { "media": { "required": true } }     ✅  the install binds it
"roots": { "media": "/Users/me/videos" }       ❌  works on exactly one machine
```

Root kinds are an **open vocabulary**: name any kind your app needs, and the box
binds it in `studio.json`. Every hardcoded path in the apps migrated so far
existed because nothing in the format asked where the user's data lives.

### `calls` — the verbs this app uses

```json
"calls": { "/api/focus": { "required": false } }
```

| field | stability | meaning |
|---|---|---|
| `calls.<verb>.required` | stable | `true` if the app does not work without it |

**`calls` is provider-agnostic and that is the point.** You declare the verb you
need, not who serves it — the box works out which installed provider answers it,
because after `provider.json` exists the box is what knows. Naming a package
here would put a fact in two places and re-couple your app to one implementation
exactly where substitutability matters most.

This is how an app depends on a verb **another** provider serves. Before `calls`
existed there was no way to say it: the old `verbs` list was scoped to your own
provider's routing, so an app calling another backend's verb worked only while
some unrelated app happened to be installed and declare it.

`required` is declared rather than derived because only the app author knows
whether an unserved verb is a missing nicety or a dead product.

### `vendor` and `requires`

| field | stability | meaning |
|---|---|---|
| `vendor[]` | stable | bare directory names under your `vendor/`, shipped with the app |
| `requires.binaries[]` | stable | binaries the app NEEDS, whoever satisfies them |
| `requires.ffmpeg_filters[]` | provisional | filters without which the app cannot work |
| `requires.ffmpeg_filters_preferred[]` | provisional | filters that degrade a feature, and must not block an install |

`vendor` entries are **bare directory names**. Prose in that field reads fine to
a human and installs nothing.

The required/preferred split on filters is load-bearing: a filter that only
draws a caption should not refuse a working studio on a box whose ffmpeg build
lacks it. Declare what is fatal separately from what is degraded.

`requires.binaries` states the NEED; `provider.supplies` states who satisfies
it. Keeping both legible means an installer can accept a provider that ships its
own ffmpeg without pretending the need was never there.

---

## `studio.json` — what this box has

```json
{
  "apps": ["files", "cutdown", "mini-nle"],
  "appsRoot": "~/code/openrig-studio-apps",
  "port": 8890,
  "roots": {
    "project": "~/studio/project",
    "media":   ["~/media", "~/archive/media"],
    "footage": "~/media/footage"
  },
  "doors": [
    { "id": "vault", "name": "VAULT", "url": "https://vault.example", "glyph": "▣" }
  ]
}
```

| field | stability | meaning |
|---|---|---|
| `apps[]` | stable | which installed apps are ON |
| `appsRoot` | stable | where apps and providers live |
| `port` | stable | the public port; the box owns one origin |
| `roots` | stable | binds each root KIND to a real location; an array binds several |
| `doors[]` | provisional | external services hung on the rail by absolute URL — not apps, not installed |
| `fixtures` | provisional | a fixtures directory, when no provider generates real state |

`~` is expanded. The four original root spellings (`sliceRoot`, `mediaRoots`,
`canvasRoot`, `footageRoot`) remain accepted as legacy aliases for `project`,
`media`, `canvas` and `footage`; an explicit `roots` entry wins.

---

## The template language

Values in `run.args`, `run.env` and companion args are substituted before the
process starts:

| token | becomes |
|---|---|
| `{{port}}` | the port this box assigned to THIS provider |
| `{{port:<package>}}` | the port assigned to another provider |
| `{{root:<kind>}}` | the bound location for that root kind |
| `{{state}}` | a directory this provider may generate real observe-state into |

Ports are **assigned by the box**, never chosen by a provider. A hardcoded
default port is how a service on a busy host answers with a stranger's data
while returning `ok: true`.

A `{{root:<kind>}}` bound to several locations repeats its preceding flag once
per location. An unbound kind removes the flag and the value together, so a
provider is not started with a dangling argument.

**`{{state}}` is a claim.** A provider whose args contain it is saying *I
generate this box's real observe-state*, and the runtime reads from there
instead of the shipped demo fixture. The fixture describes an invented rig and
is correct as an example and a lie on a deployed box.

---

## Reconciliation — what the box checks before it starts

Every check exists because its absence produced a real failure, and each one
refuses rather than coming up looking healthy.

1. **Apps enabled but none composed** — a broken install, not an empty studio.
2. **A declared companion whose file is missing** — its verbs would accept work
   nothing performs.
3. **Two providers declaring the same verb** — which backend answers would
   depend on install order.
4. **A declared call nothing serves** — see the ladder below.
5. **A port already in use** — never attach to whatever is listening.

### The unmatched-call ladder

For each entry in an app's `calls`:

| situation | outcome |
|---|---|
| a provider **already started** declares the verb | routed; nothing further needed |
| a provider **present on the box** declares it but is not started | `required: true` **starts it**; `required: false` warns and starts nothing |
| **nothing present** declares it | `required: true` refuses, naming the app and the verb; `required: false` warns |

Which provider answers is **derived** from provider declarations, never carried
in the app manifest — so it cannot go stale when a verb moves between providers.

**Optional calls start nothing.** Only `required: true` grants the authority to
start a provider no app names as its own.

**Out of scope for v0.1, stated so it is not discovered:** the box cannot name a
package it does not have. A refusal at the third rung says *nothing on this box
answers that verb* — it does not say *install `@openrig/studio-video`*, because
that would require a registry of packages the box has never seen. Acquiring a
package is the operator's step, and automatic transitive install is
package-manager territory, not this contract.

An earlier draft of this ladder had a fourth outcome that named an
available-but-uninstalled package. It was written before the implementation and
was not implementable: "present on the box" and "installed" are the same
condition here, and there is no registry behind them. It is recorded rather than
quietly dropped, because a specification that promises a refusal it cannot
produce is the failure this document exists to end.

---

## Conformance — what the shipped tools do TODAY

Stated plainly, because a contract that overstates its own implementation is the
defect this document was written to end.

| specified | shipped in `tools/` today |
|---|---|
| `app.json` identity, `surface`, `roots`, `vendor`, `requires` | **yes** |
| open root-kind vocabulary, `studio.json` `roots` | **yes** |
| the template language, `{{state}}` | **yes** |
| `provider.json` — provider-owned `run` / `serves` / `verbs` | **yes**, `compose-rail.mjs` |
| the legacy path and its warning | **yes** |
| `calls` with per-call `required` | **yes**, `compose-rail.mjs` |
| all five reconciliation checks, including the ladder | **yes** |
| `app-manifest.schema.json` **enforced** against a manifest | **not yet** — no tool reads it |
| `install-app.mjs --check` understanding `calls` / `provider.json` | **not yet** — it validates the older shape |
| `manifest_version` checked on install | **not yet** — declared, never verified |

Every row above was measured against the tools rather than remembered, after an
earlier version of this table said three shipped rows were unimplemented. The
last three are honest gaps: an author can write a manifest this document
specifies and the installer will neither validate nor understand parts of it.

**The transition converges rather than forking.** Until a provider ships a
`provider.json`, an app-declared `provider.run` / `provider.serves` / `verbs` is
still honoured, with a warning naming the app that declared it. Once the
provider declares its own, the provider wins outright and any app-side copy is
ignored with a warning naming both. There is never a moment with two
authorities.
