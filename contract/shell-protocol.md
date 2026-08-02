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

This message set is closed for v0.1: the shell ignores any other `t` value.
New message types arrive as contract additions, never by surfaces inventing
them.

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
