# Focus — what the user is looking at

contractVersion: 0.1

Everything here is **opt-in and additive**. A surface that reports no focus
behaves exactly as it did before this document existed, and `contractVersion`
does not move.

## Why this is a contract

An agent that cannot see what the user is looking at is working blind. The
measured state before this document is worse than missing: a focus record
already exists, three of four surveyed applications already write it, and
**nothing off the box can read it** — the write verb has no matching read, so
agents open the file directly.

That single gap is what this specifies away. Three measured defects come with it,
and each one is a rule below rather than a note: a second writer blanking the
record, a `selection` that means four different things, and a view change that
reports nothing because the reporter compares selections only.

## The record (stable)

```json
{
  "surface": "canvas",
  "selection": ["<whatever this surface's selection IS>"],
  "view": { "page": 2 },
  "note": "one line a human or agent may set",
  "at": "<ISO timestamp of the last change>",
  "by": "<who last wrote it>"
}
```

| field | stability | meaning |
|---|---|---|
| `surface` | stable | the id of the surface this record describes |
| `selection` | stable | **typed by that surface** — see below |
| `view` | stable | where the surface is looking: page, board, range, tab. Shape is the surface's |
| `note` | stable | one line, free text |
| `at` | stable | ISO timestamp of the last change |
| `by` | stable | the actor that last wrote it |

### `selection` is typed by its surface, never universally (stable)

Across the surveyed applications `selection` is asset **names**, opaque canvas
**shape ids**, absolute file **paths**, and timeline **slot ids** — four types
sharing one word. A universal schema would be correct for one application and
silently wrong for the rest.

So the record identifies its `surface` and the selection is read **in that
context**. A consumer that does not know how to interpret a given surface's
selection must be able to tell that it does not, rather than receive something
plausible.

This is the same decision, for the same measured reason, as the standard preserve
adapter declining `selection` in `change-signal.md`.

## Reading focus (stable)

**`GET /api/focus` — and its absence is the defect this document exists for.**

It answers the change-signal shape, so an agent polls it with the primitive
already specified rather than a second mechanism:

```json
{ "ok": true, "changed": true, "marker": "<opaque>", "focus": { "...": "the record" } }
```

`?since=<marker>` is honoured exactly as `change-signal.md` describes: the marker
is server-minted, monotonic and opaque, and a consumer compares it only for
equality. A provider serving focus declares the verb in its `signals.verbs`.

**Focus is readable over HTTP and not only from the filesystem.** Reading the
record off disk works only for a consumer on that machine, which excludes every
remote agent and every consumer in another process boundary. The verb is the
contract; where a provider keeps the record is its own business.

### The marker moves on ANY field change (stable)

Including a `view` change with an unchanged `selection`. This is stated because
the surveyed implementation compares selections only, so moving to another page
or board reports nothing — the user has plainly changed what they are looking at
and the agent is told nothing at all.

## Writing focus (stable)

**`POST /api/focus` — a write updates the fields it names and leaves the rest.**

The body is a JSON object naming the fields to change. A write answers with the
record as it now stands, and with the marker that write produced:

```json
{ "ok": true, "marker": "<opaque>", "focus": { "...": "the record after the write" } }
```

**Returning the record means a writer does not need a follow-up read** to know
what it produced, and the marker it gets back is the one a subsequent `?since=`
compares against. A write that names no known field is refused with
`{ "ok": false, "error": "<what> — <what to do>" }` and HTTP 400 rather than
silently doing nothing.

That is the whole rule, and it exists because whole-record replacement is a
measured defect: a second verb overwrote the record with `view` blanked and asset
paths reduced to basenames, so **pinning something destroyed the view context the
focus reporter had just written**. The two writers were both behaving reasonably;
the format made them collide.

So a write carrying only `selection` leaves `view` exactly as it was. A field is
cleared by naming it with an explicit `null`, which is a statement rather than an
accident.

`at` is **server-set** on every write. A timestamp the caller supplies cannot be
trusted to say when the record last genuinely changed, and it is the field a
consumer uses to decide whether focus is stale.

`by` is **caller-declared, and a runtime that has a real identity for the caller
MUST override it.** That distinction is drawn rather than glossed: attribution is
only as good as the identity behind it, and a contract that called this
server-set would be describing a guarantee the reference runtime cannot make. It
is single-process, loopback, and knows nothing about who is calling — so it
records what it was told and this table says so. **Do not build a trust decision
on `by` without knowing which kind of runtime produced it.**

## Addressing state WITHIN a surface (stable)

The same problem as focus, arriving from the other end. Focus lets an agent ask
what the user is looking at; an address lets anyone **hand that to someone else**
— a link a human pastes, a state a reload restores, a reference an agent is given
rather than described.

Across the surveyed applications there is not one use of `location.hash`,
`URLSearchParams` or `pushState`. The shell's `?s=<id>` picks *which* surface is
open and nothing addresses state *inside* one.

**The shell owns the QUERY; the surface owns the HASH.**

That split is the rule rather than a convention: `?s=` belongs to the shell, and a
surface writing there would fight the thing hosting it. So a surface's own state
goes in the hash, and the runtime helper's `readAddress` / `writeAddress` do
exactly that and leave the query untouched.

```js
import { readAddress, writeAddress } from "/signal.js";

const state = readAddress(location.href);            // {} when nothing is addressed
history.replaceState(null, "", writeAddress(location.href, { page: "3" }));
```

The address is a **flat map of strings**, because a URL is something a human is
expected to read and paste. A surface with structure to address flattens it; a
blank value is dropped rather than written as `&k=`, and an empty state clears
the hash rather than leaving a bare `#`.

**Restoring on load is the half that matters.** An address that is produced but
never read is decoration: it makes a URL that looks meaningful and restores
nothing. A surface adopting this reads the address before its first render.

## Failure modes this design answers

- **A consumer is not on the box.** It reads over HTTP. This is the whole point.
- **Two writers, one record.** Field-scoped writes; neither blanks the other.
- **The user changed page but not selection.** The marker moves; it is a change.
- **A consumer meets a surface it does not understand.** The record names its
  surface, so the consumer can say so rather than misread the selection.
- **Nothing reports focus.** The verb answers an empty record and the marker does
  not move. A surface that never reports is not an error.

## Conformance — what ships TODAY

| specified | shipped |
|---|---|
| the record, its fields, and surface-typed `selection` | **yes** |
| `GET /api/focus` answering `{changed, marker, focus}` under `?since=` | **yes**, in the reference runtime |
| field-scoped writes that cannot blank each other | **yes**, with controls |
| `at` server-set on every write | **yes** |
| `POST` answering `{ok, marker, focus}` so a writer needs no follow-up read | **yes** |
| the namespace advertised at `GET /api/contract` -> `capabilities` (`focus.read`, `focus.write`) | **yes** — and it was NOT, until an independent cold build followed the documented feature-detection path and concluded the verb was absent |
| `by` overridden from a real caller identity | **no, and it cannot be here.** The reference runtime is single-process and loopback and has no identity for its caller, so `by` is what the caller declared. A runtime that HAS one must override it |
| a provider declaring the verb in `signals.verbs` | **specified**; the reference runtime is single-process and declares nothing |
| `readAddress` / `writeAddress`, hash-owned and query-untouched | **yes**, with controls |
| a SHIPPED surface that actually addresses its state | **no.** None of the surfaces in this repository has view state worth addressing — the shell hosts, and the starter renders a fixture. The helper and its rules are contract and tested; **the first application with a view is what will exercise them**, and adding UI here purely to demonstrate it would be inventing a feature to satisfy a document |

Rows are measured against the shipped runtime rather than recalled.
