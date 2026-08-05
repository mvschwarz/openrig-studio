# Annotations — marking up a surface that knows nothing about it

contractVersion: 0.1

Everything here is **opt-in and additive**. A surface that does nothing behaves
exactly as it did before this document existed — including being fully
annotatable — and `contractVersion` does not move.

## Why this is a contract

A human and an agent looking at the same screen need a way to point at the same
thing. Focus tells an agent *what the user is looking at*; drive lets it *operate
the surface*. Neither lets either party say **"this part, here, is wrong."**

The mechanism is not speculative: a working annotation layer already existed
inside one application. What was missing is the SDK offering it, so that the next
application does not build a second, incompatible one — the same reason all three
existing primitives are here.

## Annotation is drawn by the SHELL, over the stage (stable)

**Not by the surface.** This is the load-bearing decision and everything else
follows from it.

A feature that required surfaces to cooperate would work on none of the surfaces
that already exist, which is the population that matters. So the shell draws
marks on an overlay above the stage, and a surface that has never heard of
annotation is annotatable anyway.

The consequence to internalise: **`{ "t": "markup", "on": <boolean> }` is
advisory.** `shell-protocol.md` already says so. A surface handles it only when it
wants to render its own richer marks or move its controls out of the way. Ignoring
it costs the surface nothing.

## What a mark is (stable)

```json
{
  "id": "<opaque>",
  "surfaceId": "canvas",
  "selector": "#publish",
  "shape": "circle | rect | arrow | text",
  "note": "one line: what should change",
  "source": "human | agent",
  "anchor": { "x": 0.4, "y": 0.3, "width": 0.2, "height": 0.1 },
  "text": "<the anchored element's own text, at the time of writing>",
  "status": "anchored | spatial | missing",
  "createdAt": "<ISO timestamp>"
}
```

| field | stability | meaning |
|---|---|---|
| `id` | stable | opaque, assigned by the layer |
| `surfaceId` | stable | which surface this mark was drawn on |
| `selector` | stable | a stable selector for the anchored element, or `null` for a purely spatial mark |
| `shape` | stable | closed set: `circle`, `rect`, `arrow`, `text` |
| `note` | stable | one line of free text — the point of the mark |
| `source` | stable | `human` or `agent`, and they are rendered differently on purpose |
| `anchor` | stable | normalized 0–1 rectangle, so a mark survives a resize |
| `status` | stable | see below |

### `status` is the honest field (stable)

- **`anchored`** — the selector still resolves; the mark is drawn on the element.
- **`spatial`** — the mark was never tied to an element. Correct, not degraded.
- **`missing`** — the mark HAD an element and that element is gone.

**A `missing` anchor is shown as missing rather than quietly relocated.** A mark
that silently slides to wherever the geometry now points is worse than one that
admits it lost its target: the reader believes it is still pointing at the thing
it was drawn on. This is the same rule as honest degradation in
`change-signal.md`, applied to a position instead of to a data feed.

## The sub-context — for a surface holding many documents (stable)

**The persistence scope defaults to the surface id, and that is right for almost
every surface.** One surface, one board of marks.

It is wrong for a surface that holds several independent documents behind a
single id — a canvas with pages, a viewer with tabs. Keyed on the id alone, marks
drawn on page 1 either hang over page 2 or collapse into one thread.

**The shell cannot work this out.** Only the surface knows what its documents are.
So a surface that has several MAY refine the default:

```json
{ "t": "annotation-context", "id": "<opaque, this surface's own>" }
```

Sent over the existing surface→shell channel. The id is **opaque to the shell** —
it is not parsed, matched, or interpreted, exactly as a drive op is opaque to the
runtime. Sending `null` (or omitting `id`) returns the surface to its default
single board.

**This does not make annotation depend on surface cooperation.** A surface that
never sends it gets one board keyed on its id, which is the behaviour it would
have had if this message did not exist. The message only lets a multi-document
surface be *more* correct, never less.

Only the **active** surface may declare a context, for the same reason only the
active surface may write the header: a backgrounded surface still holds a live
channel, and without the rule the scope would follow whichever surface spoke last
rather than the one on screen.

**A context change is the same event as a surface change** to anything drawing
over the stage — save what you had, load what belongs here, clear and re-anchor.
It is delivered on the existing surface-change channel rather than a new one, so a
feature never has to know sub-contexts exist.

### The scope key is composed by the SHELL (stable)

`surfaceId` when no context is declared; `surfaceId`, a **NUL** (`U+0000`), then
`contextId` when one is. **A consumer must treat the whole key as opaque** and must not build it
itself — two places composing one key is two places computing one property, and
they drift silently. `NUL` cannot appear in either part, so the two halves cannot
be confused for one another.

## The verbs (stable)

**`GET /api/annotations?scope=<key>`**

```json
{ "ok": true, "scope": "<key>", "records": [ { "...": "a mark" } ] }
```

**A read with no `scope` answers an EMPTY set, never every scope on the box.** A
caller that forgot the parameter would otherwise receive another surface's marks
and render them over this one — a plausible answer to a question nobody asked.

**`POST /api/annotations`** — body `{ scope, records }`, answering
`{ ok, scope, records }`. The whole set for that scope is replaced, because the
layer owns the board and sends what it now holds. A write naming no scope, or
carrying no `records` array, is refused by name with HTTP 400 rather than
silently doing nothing.

**These verbs are substitutable.** They answer *stored marks*, which is data on
the box — like the files verbs and unlike `/api/contract`. A provider that knows
where a real studio keeps its annotations should serve them, and the rule in
`runtime-api.md` applies unchanged: the documented shape binds whoever serves it.

## Persistence is disclosed, never assumed (stable)

`GET /api/contract` reports:

```json
"annotations": { "persistence": "memory" | "file", "scopes": 0, "writes": 0 }
```

**Measured, not declared** — the same rule as `drive.listening`. And the layer
says the same thing where the user can see it: a board with no store behind it
reads **"session only"** rather than "persisted".

That distinction is the whole point of reporting it. "Your marks are saved" and
"your marks vanish when you close this tab" are two different promises to whoever
just drew one, and they must not look alike.

The reference runtime keeps marks **in memory** unless started with
`--annotations <file>` (or `OPENRIG_STUDIO_ANNOTATIONS`). Two reasons it is not a
default path:

- **Not under the fixtures directory.** The change signal watches it recursively,
  so a marks file there would fire the signal on every write — annotating a
  surface would reload the surface being annotated, and the defect would read as a
  bug in the surface.
- **Not inside the package.** A boot step that writes into an installed package
  makes `node_modules` state rather than dependencies, and a copied tree then
  carries one instance's marks into another.

## Conformance — what ships TODAY

| specified | shipped |
|---|---|
| the shell drawing marks over the stage, on a surface that does not cooperate | **yes**, browser-verified on an unmodified surface |
| the mark record, its fields, and the closed shape set | **yes** |
| `anchored` / `spatial` / `missing`, with a missing anchor shown as missing | **yes** |
| `GET` / `POST /api/annotations`, scoped | **yes**, with controls on both refusal directions |
| a scope-less read answering empty rather than everything | **yes**, with a control |
| `{ t: "annotation-context" }` refining the scope | **yes** — verified in a live shell: a surface declaring one gets its own empty board, marks drawn there stay there, and declaring `null` restores the default board intact |
| the active-surface-only rule on that message | **yes, but the committed check is STRUCTURAL** — it asserts the `e.source` guard is present in the shell, with a control proving the check can fail. The behaviour was verified by driving a live shell; this repository has no browser dependency to re-run that automatically |
| the scope key composed by the shell and opaque to consumers | **yes** |
| persistence reported at `GET /api/contract` and shown in the UI | **yes** |
| marks surviving a runtime restart | **yes when `--annotations <file>` is configured**; in memory otherwise, and the layer says "session only" |
| human and agent marks rendered distinguishably | **yes** |
| an agent handle to add and remove marks | **yes** — `window.studioAnnotations.annotate()` / `.remove()` / `.list()` |
| **a mark anchored across a CROSS-ORIGIN surface** | **no.** A cross-origin iframe cannot be read for element identity, so marks there are spatial only and say so. Same-origin surfaces get element anchoring |
| **agreement about a mark between two people watching at once** | **no.** Last write for a scope wins. Concurrent annotation needs the write-path concurrency `change-signal.md` deliberately excludes, and inventing it before two real watchers exist would be the wrong shape |

Rows are measured against the shipped runtime rather than recalled.
