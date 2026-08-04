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
| `by` overridden from a real caller identity | **no, and it cannot be here.** The reference runtime is single-process and loopback and has no identity for its caller, so `by` is what the caller declared. A runtime that HAS one must override it |
| a provider declaring the verb in `signals.verbs` | **specified**; the reference runtime is single-process and declares nothing |

Rows are measured against the shipped runtime rather than recalled.
