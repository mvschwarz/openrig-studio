# The shell protocol — lifecycle, URL rules, and the postMessage API

contractVersion: 0.1

The shell (`/`, served from `app/shell.html`) is the hallway: a rail of
surfaces on the left, a stage that hosts one surface at a time in an iframe,
and an agent sidebar. This document is what a surface may rely on.

## URL resolution (stable)

- A row with `path` is loaded same-origin: `{origin}{path}`.
- A row with `url` is loaded as given (external surfaces).
- Deep link: `?s=<id>` opens that surface directly and survives reload;
  the shell keeps the address bar in sync as the user switches surfaces.

## Surface lifecycle (stable)

- The stage iframe for a surface is created on **first visit** and **kept
  alive** when the user switches away — your surface keeps its state and its
  open connections while backgrounded.
- Exception: rows with `unmountOnBlur: true` have their iframe **removed** on
  switch-away and recreated on return. Declare this if your surface holds an
  attachment that must not persist invisibly (terminal viewers are the
  canonical case: a hidden kept-alive client stays attached and fights the
  visible ones). Cost: your surface cold-starts on each return.
- `popout: true` rows open in a new browser tab instead of the stage.
- `hideAgents: true` suppresses the agent-sidebar toggle while your surface
  is active.

## Liveness (stable behavior, cosmetic result)

The shell polls every surface URL with an opaque no-cors fetch on an interval
and renders a rail dot: answered = live, failed = down. Your surface needs no
code for this — just answer HTTP.

## The postMessage API — the ONLY surface→shell channel (stable)

Send from inside your iframe with `parent.postMessage(msg, "*")`:

| Message | Effect |
|---|---|
| `{ "t": "open-surface", "id": "<surface-id>" }` | The shell activates that surface (same as a rail click). Unknown ids are ignored. |
| `{ "t": "open-agent" }` | The shell opens the agent sidebar. |
| `{ "t": "open-agent", "seat": "<seat-name>" }` | Opens the sidebar with that roster seat highlighted. Unknown seats open the sidebar unhighlighted. |
| `{ "t": "header", … }` | Declares the surface's half of the header. See *The header splits in half* below. |
| `{ "t": "annotation-context", "id": "<opaque>" }` | Refines which board of annotations this surface is showing. Only for a surface holding several documents behind one id — see `annotations.md`. `null` or omitted returns to the default. |
| `{ "t": "annotation-target", "frame": "<iframe element id>" }` | Names a **same-origin nested iframe** whose document annotations should anchor inside. For a surface that hosts its real content in a frame. `null` or omitted returns to the surface's own document. |
| `{ "t": "annotation-refresh" }` | "I moved something — re-measure." Repaints anchored marks without reloading the board or disturbing undo. Needed because an element that *moves* changes no size and no scroll, so nothing else fires. |

This message set is closed: the shell ignores any other `t` value. **New message
types arrive as contract additions, never by surfaces inventing them** — which is
why each of the two additions since v0.1 shipped was documented in this table in
the same commit that implemented it, rather than being discovered later by reading
the shell.

Every one of these is **additive and optional**. A surface that sends nothing at
all is a correct surface: it gets a header from its manifest row, one board of
annotations, and no loss of function.

## The agent sidebar (what "seat" means in v0.1)

The contracted seat surface is deliberately small:

- Seats are **declared** as `chatSeats[]` roster rows in the manifest.
- A surface may **summon** the sidebar (`open-agent` above).

That is the whole contracted seat surface in v0.1. Typing into a seat and
richer seat→surface channels exist in some runtimes as **runtime-internal**
capability (see `runtime-api.md`) and are not contract. The reference runtime
renders the roster and says honestly that no live seat backing is present.

## The change-signal loop (how a surface stays fresh)

The canonical read loop for a live surface:

1. Fetch what you need from the observe/files verbs (`runtime-api.md`).
2. Open `GET /api/events` (SSE). On **any** message: re-fetch what you care
   about. Do not parse event payloads — the stream is a signal, not a data
   channel.
3. If the stream errors or emits a `degraded` event: close it and fall back
   to polling, and keep retrying the stream when convenient.

**Freshness bound (fallback polling):** poll every **10–30 seconds** while the
stream is down; **15 seconds is the recommended default**. Faster than 10s
wastes work against a signal-driven runtime; slower than 30s reads as stale to
a human watching the surface. When the stream reconnects, stop polling and
re-fetch once.

This loop is the intended pattern; the fixture runtime fires the signal when
fixture or manifest files change, so you can watch it work by editing a
fixture file.

## The shell chrome — what the shell draws and a surface does not (stable)

The shell provides **two persistent frames** and a surface renders inside them:

| frame | what it is | who owns it |
|---|---|---|
| the launcher rail, left | which surfaces exist, which is open | the shell |
| the header, top | what you are looking at, and studio-level controls | the shell |

**A SURFACE DOES NOT DRAW ITS OWN TITLE BAR.** The header already names the open
surface and carries its hint. A surface that draws one too produces two headers
stacked on one screen, and — worse than the wasted room — **switching surfaces
then flips between one header and two**, so the studio reads as a set of pages
rather than one application. That was measured across five apps before this rule
was written: three drew their own, two did not.

### The header splits in half (stable)

| half | belongs to | holds |
|---|---|---|
| **left** | the **app** | its title, its crumb, its own actions |
| **right** | the **shell** | the agent sidebar opener, markup |

**A surface DECLARES what goes in its half; it never draws it.** That distinction
is the whole rule. Declaring means the shell renders it, so there is exactly one
header on screen and the shell is never surprised by markup it did not write —
which is what closes the two-headers problem in the contract rather than by asking
every app to delete something.

Send over the existing surface→shell channel:

```json
{ "t": "header",
  "title": "CUTDOWN",
  "crumb": "take-04.mov · 3 cuts",
  "actions": [ { "id": "export", "label": "EXPORT" },
               { "id": "grid", "label": "GRID", "on": true } ] }
```

Every field is optional. A surface that sends nothing keeps the shell's defaults —
the surface's name and hint from its manifest row — so an existing surface needs no
change and still gets a correct header.

Clicking a declared action posts **`{ "t": "header-action", "id": "<id>" }`** back
to the surface. The shell does not know what any action means and does not try:
it renders a label and returns the click.

**Only the ACTIVE surface may write the header.** A background surface is still
running and still holds a live channel, so without that rule the header shows
whichever surface spoke last rather than the one you are looking at. Actions are
cleared when the shown surface changes — a stale button that still looks live is
worse than an empty space.

**This replaces the earlier rule that per-app actions stay in the surface body.**
The slot exists now, and it is the left half.

**The rail collapses to a toolstrip** and a surface must not assume its width.
Anything that measures the viewport should measure it, not compute it from a
constant — the surface's own width changes when the launcher collapses and when
the agent sidebar opens.

### Studio-level controls live in the header (stable)

The header is where controls that mean the same thing on every surface live — the
agent sidebar opener, and markup. A surface does not reimplement them; the point
of a studio-level control is that it is the same one everywhere. **Two controls
for one mode are two things that can disagree, and the one a surface did not write
is the one that will be wrong.**

**`{ "t": "markup", "on": <boolean> }`** is sent from the shell **to** the active
surface when markup mode changes. It is the one message that travels in that
direction, and it is **advisory**: a surface that ignores it is unaffected and
still annotatable, because annotation is drawn by the shell over the stage rather
than by the surface. A surface handles it only when it wants to participate — to
render its own richer annotations, or to get its own controls out of the way.

**Do not build a feature that requires this message.** A shell feature that only
works on surfaces which cooperate is a feature that does not work on the surfaces
that already exist.

**Annotation is the worked example of that rule.** The shell draws marks on an
overlay above the stage, so every surface is annotatable including ones written
before the feature existed. A surface may refine *which board* it is showing with
`annotation-context` when it holds several documents behind one id, but it is
never asked to draw, store, or understand a mark. See `annotations.md`.

## Surface expectations (visual / accessibility baseline)

v0.1 deliberately declares **no required visual system and no enforced
accessibility baseline** — surfaces are sovereign inside their iframe. Two
conventions are stated so surfaces cohere with the shell without a rulebook:

- Declare `color-scheme: dark` (the shell is dark; a light-flashing iframe
  reads as broken).
- Degraded and error states must be **visible in the UI**, not only in the
  console — when something is wrong it must look wrong.

A formal baseline (contrast, keyboard reachability, test convention) is a
candidate for a later contract version, not an unstated v0.1 rule.
