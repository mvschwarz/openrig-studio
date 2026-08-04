# Drive — an agent operating the surface

contractVersion: 0.1

Everything here is **opt-in and additive**. A surface that adopts nothing behaves
exactly as it did before this document existed, and `contractVersion` does not
move.

## Why this is a contract

The third of three primitives, and the one that changes what an agent IS. With
`change-signal.md` a surface stays fresh; with `focus.md` an agent can see what
the user is looking at. Without this one it can still only *describe* what should
happen next and leave the person to do it.

The mechanism is not speculative: a working drive channel already exists in an
application built on this SDK, and it is the reason that application can be
watched rather than merely instructed. What was missing is the SDK offering it, so
that two applications do not invent two incompatible versions of the same thing.

## The op (stable)

An op carries **intent**, and the runtime attaches two fields:

```json
{ "gen": 7, "at": "<ISO timestamp>", "...": "whatever this surface's intent IS" }
```

| field | stability | meaning |
|---|---|---|
| `gen` | stable | server-assigned generation, strictly increasing |
| `at` | stable | ISO timestamp the runtime recorded the op |
| everything else | **the surface's** | intent, interpreted by the surface alone |

### The op is opaque to the runtime, and is never a list of DOM operations (stable)

The runtime never interprets an op. Two consequences, both deliberate.

**It cannot become a second renderer.** A runtime that understood ops would need
to know what every surface can do, and would have to be extended before any
surface could gain a capability.

**A driver never addresses a surface's structure.** Ops say "show take 3", not
"click the third button". A driver reaching into markup breaks on any re-layout,
and would force every drivable surface to freeze its DOM as an interface it never
agreed to publish. This is the same decision, for the same reason, as `selection`
being typed by its surface in `focus.md`.

## The channel (stable)

**`POST /api/drive`** — an agent posts an op. The runtime assigns `gen` and
answers `{ ok, marker, op }`.

**`GET /api/drive`** — the surface polls. It answers the change-signal shape:

```json
{ "ok": true, "changed": true, "marker": "<opaque>", "op": { "...": "the latest op" } }
```

`?since=<marker>` is honoured exactly as `change-signal.md` describes. A surface
already watching the change signal or focus is watching this **with the primitive
it already has**, rather than a third polling mechanism of its own.

A runtime nobody has driven answers `op: null`. That is not an error.

### Latest intent wins; superseded ops are DROPPED (stable)

This is a **generation counter, not a queue**, and the distinction is the whole
design. A surface asks "is there anything newer than what I have?" and applies the
newest op, discarding everything superseded.

A queue lets a slow page fall behind and then work through instructions that were
true minutes ago — animating through states nobody asked to see and acting on
stale intent **while looking perfectly healthy**. A surface that is behind and a
surface that is current are indistinguishable to someone watching, which is what
makes the queue version survive review.

### Ops posted BEFORE a surface loaded are history, not instructions (stable)

A surface adopts whatever generation is already there as its **baseline** on its
first poll, and applies nothing. Only ops posted after it started listening are
applied.

This is stated because the other behaviour is what you get for free, and it is the
more surprising one. The runtime keeps the last op indefinitely, so without a
baseline every page that has never seen an op treats it as new: a reload re-runs
it, a second tab runs it again, and opening the surface an hour later runs it once
more. For a `select` that is harmless. For `play`, `export` or `delete` it is a
side effect nobody asked for, arriving unbidden and repeatedly.

Both readings are defensible, which is exactly why the surprising one must not be
the silent default.

**`resumeLatestOnLoad: true`** opts back in, for a surface whose ops are pure view
state and which genuinely wants a fresh page to catch up to the latest intent.

**The one race, stated rather than hidden:** an op posted in the window between a
surface loading and its first poll being answered is treated as pre-existing and
skipped. The window is one poll interval. It is the unavoidable cost of the
surface being unable to distinguish an op posted moments before it existed from
one posted an hour before, and it fails toward doing nothing rather than toward
acting on stale intent.

### Applications are serialised (stable)

A surface must not begin applying an op while another is still being applied. Two
overlapping applications interleave their writes and leave the surface in a state
**neither op described**. An op arriving mid-flight is held, and when the flight
lands only the newest held op runs — so serialising never reintroduces a queue.

## Adopting it (stable)

```js
import { driveSurface } from "/signal.js";

const drive = driveSurface({
  apply: async (op) => {
    if (op.show !== undefined) await showTake(op.show);
    if (op.say) narrate(op.say);          // let the agent say WHY, where the surface talks
  },
});
```

`apply` is awaited, so returning a promise is how a surface tells the helper that
it is still working. `offer(op)` hands an op in directly for a surface driven by
something other than the verb, and `stop()` ends the polling.

**Narrate the change.** An op may carry a line of text the surface shows where it
normally talks to the user. A watcher then sees a narrated change rather than
controls twitching on their screen, which is the difference between a tool that
feels driven and one that feels haunted.

## Failure modes this design answers

- **A slow page acting on stale intent.** Superseded ops are dropped, not queued.
- **Two ops interleaving.** Applications are serialised; only the newest waits.
- **The runtime going away.** The poll survives it. A surface that stopped polling
  on the first failed request would need a manual reload to become drivable again
  — the state this primitive exists to remove.
- **A driver breaking on a re-layout.** Ops carry intent, never structure.
- **A surface that adopts nothing.** Unaffected; the verb simply has no listener.

## Conformance — what ships TODAY

| specified | shipped |
|---|---|
| `POST` / `GET /api/drive`, opaque ops, server-assigned `gen` | **yes**, in the reference runtime |
| the change-signal `?since=` shape on the read | **yes** |
| `driveSurface` dropping superseded ops | **yes**, with a control that plants a queue and fails |
| not replaying ops that predate the surface, and `resumeLatestOnLoad` opting back in | **yes**, with controls on both directions — including that a post-load op still applies, so the baseline cannot be satisfied by a surface that stopped listening |
| `driveSurface` serialising applications | **yes**, with a control that measures overlap directly |
| the poll surviving a runtime that has gone away | **yes**, with a control |
| **a surface REFUSING an op it cannot honour, and saying why** | **no, not yet.** The hard case: an agent asks for something the surface cannot do right now — sound a browser will not grant without a click, a file that is gone. A bare rejection is useless to a driver; a refusal must carry the current state so the agent can decide what to do instead. Specified nowhere yet, because a refusal shape invented before a real application needs one would be the wrong shape |
| a SHIPPED surface in this repository that is drivable | **no.** The shell hosts and the starter renders a fixture; neither has anything worth driving. The helper and its rules are contract and tested, and the application that proved the mechanism lives outside this repository |

Rows are measured against the shipped runtime rather than recalled.
