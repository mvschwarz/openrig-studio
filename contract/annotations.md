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

## The nested-frame target — for a surface that hosts its real content (stable)

A surface that renders its actual document in a **same-origin nested iframe** has
a second problem, and it is not the same as the sub-context. The layer resolves
selectors against the *surface's* document, so an agent naming `#publish` finds
the host surface's own chrome rather than the document the human is looking at.

**And it fails in the worst available way.** If the host happens to carry that id
too, the mark renders, reports `anchored`, and sits on the wrong element — nothing
errors and nothing looks degraded. If it does not, the mark reports `missing` and
the agent's whole point is lost.

So a surface may name the frame to look inside:

```json
{ "t": "annotation-target", "frame": "<element id of a same-origin iframe>" }
```

**The surface names the frame; it does not hand over a document and it does not
compose the persistence scope.** `null` or omitted returns to the surface's own
document. Active-surface-only, the same guard as everything else on this channel.

**This is orthogonal to the sub-context above.** The context says *which board*;
the target says *where to look*. A surface can need either without the other, and
merging them would force a surface with a nested frame to invent document
identities it does not have.

**The shell resolves the chain**, because a nested frame's
`getBoundingClientRect()` is relative to its *parent's* viewport rather than the
top window — the offsets have to be added or every anchor lands somewhere plausible
and wrong. Doing that walk in one place is the same rule as composing the scope key
in one place.

**Cross-origin stays spatial and honest.** A cross-origin nested frame cannot be
read for element identity, so the target silently falls back to the surface
document rather than pretending: the alternative is anchors that can never resolve.

## Re-measuring when the surface moves something (stable)

An anchored mark is redrawn from its element's *current* rect on every render, so
it follows anything the shell can observe: a window resize, a scroll, the surface
frame changing size. **It cannot observe an element that MOVES.**

A canvas item dragged across a board changes neither the viewport nor the scroll
position nor any element's size, so nothing fires and the mark stays at the old
geometry — still reporting `anchored`, still looking correct. Measured: an item
moved 300px right and 180px down and the mark stayed put until an unrelated window
resize snapped it.

Two ways to say "I moved something, re-measure":

```json
{ "t": "annotation-refresh" }
```

and, for a caller that already holds the handle, `window.studioAnnotations.refresh()`.

**Both re-measure without reloading.** The board is not re-read, records are not
touched, and undo history survives — which is the distinction from a surface or
context change, where reloading is the correct behaviour.

**Re-posting `annotation-target` with the same frame id is deliberately a no-op**
and is not the way to nudge. Overloading it would make every redundant declaration
re-anchor and reset undo, so the nudge has its own verb.

The layer also observes size and scroll on the anchored document, which are the
cases the browser reports for free. **Those are a convenience and are explicitly
not sufficient** — the explicit hook exists because motion within an unchanged
viewport is invisible to every observer short of polling each frame.

### The worked pattern: an app opens an artifact in its own modal

The case the three messages exist for, in the order they are sent. An app that
opens a document in a modal of its own — a viewer, a preview, an artifact pane —
declares all three per navigation and hands them back on close:

```js
// opening
parent.postMessage({ t: "annotation-target",  frame: "artifactFrame" }, "*");
parent.postMessage({ t: "annotation-context", id: artifactId }, "*");
parent.postMessage({ t: "open-markup" }, "*");          // optional, see shell-protocol.md

// closing
parent.postMessage({ t: "annotation-target",  frame: null }, "*");
parent.postMessage({ t: "annotation-context", id: null }, "*");
```

**With the modal open the shell anchors inside the artifact, so a mark lands on
the picture rather than on the panel around it.** Handing the target back on close
is what stops the next mark anchoring into a modal that is gone.

Reported by an app author building exactly this; recorded here rather than left to
be rediscovered, because the seam is only obvious once you have needed it.

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

## Rasterising a marked-up surface (stable, and measured)

Marks are **plain SVG** drawn over the stage, which makes an annotated screenshot a
compositing job rather than a screenshot API: draw the evidence to a canvas, draw
the serialised overlay on top, export.

**Measured, because the constraint here is not where you would guess:**

| what is rasterised | serialised via | canvas exports? |
|---|---|---|
| plain SVG shapes | `blob:` URL or `data:` URI | **yes** |
| SVG containing `<foreignObject>` | **`data:` URI** | **yes** |
| SVG containing `<foreignObject>` | **`blob:` URL** | **NO — `toDataURL` throws** |
| a same-origin image or video frame | n/a — `drawImage` directly | **yes** |
| an `<iframe>` element | n/a | **never — `drawImage` throws `TypeError` at any origin** |

**SERIALISE TO A `data:` URI, NOT A `blob:` URL.** That is the whole rule, and it is
stated this precisely because the obvious summary — "`foreignObject` taints" — is
FALSE and expensive: text marks use `foreignObject` so they WRAP, and a contract
saying they taint would push the next person back to a single-line `<text>` that
runs off the edge of its box.

Not about external resources either: a `foreignObject` holding no image, a
same-origin image, or a cross-origin image all taint equally through a `blob:` URL,
and none of them taint through a `data:` URI. That causal story — "it taints when
it pulls something external" — sounds right, was offered with a real measurement
behind it, and is false; it is recorded here so nobody re-derives it.

**⚠️ AND `blob:` IS THE CONVENTIONAL OPTIMISATION, WHICH IS WHY THIS NEEDS ITS
REASON ATTACHED.** Swapping a `data:` URI for a `blob:` URL is the standard way to
avoid a large base64 string, so someone will eventually make that change as a
tidy-up and silently break capture for every artifact carrying a text mark —
nothing throws at the swap, the export just starts failing later. A rule stated
without its reason reads as an arbitrary preference and gets optimised away.

**A same-origin video must have data before it is drawn.** `drawImage` on a video
at `readyState 0` does not throw — it draws nothing. Wait for `readyState >= 2`
and verify pixels, or a capture of an empty frame reports as a success.

## Conformance — what ships TODAY

| specified | shipped |
|---|---|
| the shell drawing marks over the stage, on a surface that does not cooperate | **yes**, browser-verified on an unmodified surface |
| the mark record, its fields, and the closed shape set | **yes** |
| `anchored` / `spatial` / `missing`, with a missing anchor shown as missing | **yes** |
| `GET` / `POST /api/annotations`, scoped | **yes**, with controls on both refusal directions |
| a scope-less read answering empty rather than everything | **yes**, with a control |
| `{ t: "annotation-context" }` refining the scope | **yes** — verified in a live shell: a surface declaring one gets its own empty board, marks drawn there stay there, and declaring `null` restores the default board intact |
| `{ t: "annotation-target" }` anchoring inside a same-origin nested frame | **yes** — browser-proven against a DECOY: a host surface and its nested document both carrying `#publish`, with the mark hit-tested to confirm it landed on the artifact's button and not the host's |
| cross-origin nested frames degrading to the surface document rather than failing | **yes**, guarded; those surfaces stay spatial-only as they already were |
| `{ t: "annotation-refresh" }` and `refresh()` re-measuring a MOVED element | **yes** — measured before and after: an element moved 300×180px left the mark stale by exactly that offset, and both paths closed the gap to 0×0 without reloading the board |
| the active-surface-only rule on those messages | **yes, but the committed check is STRUCTURAL** — it asserts the `e.source` guard is present in the shell, with a control proving the check can fail. The behaviour was verified by driving a live shell; this repository has no browser dependency to re-run that automatically |
| the scope key composed by the shell and opaque to consumers | **yes** |
| persistence reported at `GET /api/contract` and shown in the UI | **yes** |
| marks surviving a runtime restart | **yes when `--annotations <file>` is configured**; in memory otherwise, and the layer says "session only" |
| human and agent marks rendered distinguishably | **yes** |
| an agent handle to add and remove marks | **yes** — `window.studioAnnotations.annotate()` / `.remove()` / `.list()` |
| **a SHIPPED app in this repository that actually consumes these seams** | **yes** — the bundled ARTIFACTS app uses the context, target and refresh messages and holds no annotation implementation of its own. Its migration was browser-verified by the QA seat that requested the seams, not by the author of them; the per-page isolation and element anchoring were measured against a live studio after a full restart. **This is the row the sibling primitives still answer "no" to** — `focus.md` and `drive.md` have no in-repo consumer, and both say so |
| **a mark anchored across a CROSS-ORIGIN surface** | **no.** A cross-origin iframe cannot be read for element identity, so marks there are spatial only and say so. Same-origin surfaces get element anchoring |
| **agreement about a mark between two people watching at once** | **no.** Last write for a scope wins. Concurrent annotation needs the write-path concurrency `change-signal.md` deliberately excludes, and inventing it before two real watchers exist would be the wrong shape |

Rows are measured against the shipped runtime rather than recalled.
