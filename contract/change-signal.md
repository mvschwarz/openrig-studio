# The change signal — markers, refresh, and state that survives a reload

contractVersion: 0.1

Everything in this document is **opt-in and additive**. A surface that adopts
none of it behaves exactly as it did before this document existed, and
`contractVersion` does not move.

## Why this is a contract and not a guide

Five independent implementations invented the same shape without coordinating: a
poll, a monotonic marker, and a last-seen cursor. That is not five implementation
details — it is one primitive the SDK never offered, so everyone built it. The
ones that got a **server-minted** token work; the one that computes its marker
client-side misses changes.

The runtime already documents `GET /api/events`, and a search across the apps
built on this SDK finds no uses of it. Hand-rolled polls stand in for it at
cadences spread from sub-second to half a minute. **A contract nothing implements
is not a contract; it is a claim.** So this document specifies the *marker*,
which is the part every one of those implementations agreed on, and leaves the
transport open, which is the part they all disagreed on and were right to.

## The marker (stable)

A **marker** is a token that identifies a version of a provider's state. It is:

- **server-minted** — the provider issues it. A consumer never computes one.
- **monotonic** — it advances as state advances.
- **opaque** — a counter, a revision, an mtime-derived token, a hash: the
  provider's choice. A consumer may only compare it for **equality** with the one
  it last saw. Ordering, arithmetic and parsing are all out of contract.

### Asking whether anything changed (stable)

Any observe verb **may** accept `?since=<marker>`. When it does, it answers:

```json
{ "ok": true, "changed": true, "marker": "<opaque>", "...": "the payload as before" }
```

| field | stability | meaning |
|---|---|---|
| `changed` | stable | whether state moved since the marker the caller sent |
| `marker` | stable | the provider's CURRENT marker, sent on every response |
| the payload | stable | the verb's ordinary body. A `changed: false` response **may** omit it |

A caller sending no `?since=` gets the verb's ordinary behaviour plus a `marker`,
which is how a consumer obtains its first cursor.

`marker` is returned even when `changed` is `false`. A response that reported a
change without saying what to store next would force the consumer to re-derive
its own cursor, which is the client-side computation this contract exists to
remove.

### A client-computed signature is NOT a marker (stable)

Hashing or summarising the payload on the client and comparing that to the last
summary is **non-conformant**. It is named here rather than left as a style
difference because it is the one approach that measurably misses changes: a
signature covers the fields the consumer happened to include, so a change to
anything else — or a change the payload does not expose at all — is invisible. A
server marker moves whenever the server says it moved.

### A marker that goes backwards is a CHANGE (stable)

Monotonicity is the provider's promise. A consumer that trusted it blindly would
go silent forever if it were broken, so **any marker that differs from the stored
one counts as changed**, including one that appears to move backwards or is
reissued after a provider restart. A surprise fails toward re-reading rather than
toward nothing.

## The marker is normative; the transport is NOT (stable)

**Polling is fully conformant.** A surface that never opens `GET /api/events` and
simply polls the declared verbs is correct, complete, and requires no apology.

`GET /api/events` remains what `runtime-api.md` describes: an optional accelerant
that may tell a surface to re-read sooner. Nothing is required to implement it,
and nothing may require it of a consumer.

This is deliberate. The existing documented signal mandated a transport, and the
result is a contract implemented by nothing with a scattering of bespoke polls
standing in for it. A helper that mandated one shape would earn the same fate.
Specify what the implementations agreed on; leave open what they did not.

Cadence guidance for polling is in `shell-protocol.md`.

## DATA changed and CODE changed are different events (stable)

They call for different responses, and conflating them is why refresh reads as a
loss rather than as a flicker.

| event | correct response |
|---|---|
| **DATA changed** | apply in place. No reload, no scroll jump, no lost focus ring |
| **CODE changed** | the served bytes are new, so the page must actually reload |

### The CODE trigger is PROCESS IDENTITY, never a file mtime (stable)

`GET /api/contract` reports `runtime.boot`: an opaque id, stable for the life of
the process and different after a restart (see `contract-meta.md`).

The reason this is the trigger, and it is unobvious enough to state: **a studio
copies surfaces into its runtime directory at boot**, so edited source does not
reach the browser until a restart. Watching the file announces a change the page
cannot yet see. Watching the restart announces exactly the moment new code became
servable.

**Latch the identity on your FIRST OBSERVATION — successful or not — and reload
when it CHANGES.**

The "or not" is load-bearing. Latching on the first *successful* poll is a
measured defect in the implementation this replaces: a restart that straddles a
consumer's startup is never detected, because by the time a poll succeeds it is
already the new process and its id becomes the baseline. Recording that the first
observation happened, even when it failed, makes the later real id a change
rather than a baseline.

A first observation only *records* the identity. A surface that opens after a
restart therefore does not immediately reload itself.

## What a provider declares (stable)

In its `provider.json` (see `app-manifest.md`):

```json
"signals": { "verbs": ["/api/canvas"], "boot": true }
```

| field | stability | meaning |
|---|---|---|
| `signals.verbs[]` | stable | the observe verbs this provider honours `?since=` on |
| `signals.boot` | stable | `true` when the provider mints a process identity and exposes it, which is what makes a CODE change detectable at all |

A provider that declares neither is not broken — the helper is inert against it
and its surfaces behave as they do today.

## What a surface declares (stable)

In its manifest row (see `surface-row.schema.json`), additively:

```json
"preserve": ["scroll", "selection", "form", "playhead"]
```

Naming what to keep across a CODE reload. **The runtime supplies the capture and
restore; the surface supplies only the list.** An app says WHAT to keep, not HOW.

The four names above are the standard kinds. A surface needing something else
supplies a `getState`/`setState` pair to the helper for that value.

This lives in the contract rather than in a guide because it has already been
solved once by hand, in a private `sessionStorage` key, in one application — and
its sibling, on the same provider and the same trigger, reloads bare and loses
everything. Solved once, did not propagate. That is what an SDK is for.

## "Smooth", defined so it can be tested (stable)

For a surface declaring `preserve`, a CODE reload must:

1. restore every declared kind;
2. restore before first paint of the restored view, so the user does not watch an
   empty state fill in;
3. **say the state was kept** — deliberately, once, and not as an error;
4. discard nothing the human had uncommitted in order to achieve it.

Point 3 is not decoration. A restore that silently succeeds after a reload the
user did not expect makes the reload invisible, and an unexplained reload is
exactly the thing a user learns to distrust. Saying it once keeps the reload
legible while keeping the work.

## Human-wins (stable)

**While a surface reports itself dirty, refresh DEFERS.** It does not merge and
it does not clobber. The deferred change is applied when the surface reports
itself clean.

An in-progress human edit outranks an agent write. This is stated as a rule
rather than left to each surface because both reference codebases arrived at it
independently — a poll that skips while dirty, a poll that skips while saving or
loading, a poll that skips while a modal is open. Three coincidences are a rule
nobody had written down.

A surface holding an uncommitted field is dirty. **Tab commits a field; blur does
not** — blur fires when a window loses focus or a user clicks away, neither of
which expresses intent, and a commit-on-blur turns an accidental click into a
write. A field left uncommitted on blur keeps the surface dirty, so refresh keeps
deferring.

**Write-path concurrency is NOT in this contract.** Optimistic concurrency — where
the loser of a conflicting write is handed the current content to merge — belongs
to the write path. It is named here only so it is not re-invented as a refresh
rule.

## Honest degradation (stable)

**A failed or stalled signal must be visible in the surface.** A dead provider
must not look like a quiet one.

`shell-protocol.md` already requires degraded states to be visible in the UI
rather than only in the console. It is repeated here because every hand-rolled
poll this document replaces violates it with a bare `catch {}`, which is the
single most common defect in the implementations surveyed.

Recovery is reported too: a surface that announced degradation must announce when
the signal comes back, or the first failure is permanent in the UI.

## The runtime helper (stable)

The runtime serves `/signal.js`, an ES module a surface may import:

```js
import { watchSignal, preserveAcross, deferWhileDirty } from "/signal.js";
```

| export | what it does |
|---|---|
| `watchSignal` | runs the loop: holds a cursor per verb, polls, reports DATA changes, reloads on a CODE change, and reports degraded transitions |
| `preserveAcross` | captures state before a reload and restores it after, once, saying so |
| `declaredKinds` | reads a surface's OWN `preserve` list out of the served manifest |
| `preserveDeclared` | drives capture and restore from that list through an adapter |
| `deferWhileDirty` | holds a change while the surface reports itself dirty and applies it when clean |

`declaredKinds` distinguishes three answers a surface can act on differently: the
row declares kinds, the row declares nothing, or **there is no row** — the last
being a registration failure that must not read as a deliberate empty list. A
`preserve` that is present but not an array is reported for the same reason:
absence is silent because the field is optional; a declaration that does nothing
is not.

`preserveDeclared` takes an **adapter** — `{ get(kind), set(kind, value),
supports?(kind) }` — and has no default. A kind the adapter cannot handle is
reported, never dropped quietly, and calling it without an adapter throws rather
than preserving nothing silently.

The helper is a convenience, not the contract. **A surface that implements the
marker semantics itself is fully conformant** — the contract is the marker, the
declarations, and the behaviours above.

`watchSignal` takes its fetch implementation as a parameter, which is what lets a
consumer test its own adoption without a browser or a live provider.

## Failure modes this design answers

- **The provider is dead.** The poll fails; the surface shows degraded, visibly.
- **The provider restarted mid-poll.** Process identity changed — that is a CODE
  change and is handled as one.
- **A change arrives while the human is mid-edit.** Deferred, not merged.
- **A change arrives for a surface that is gone.** The loop is per-surface and
  dies with the frame. A signal for an unmounted surface is dropped, not queued.
- **The marker went backwards.** Treated as changed.
- **Nothing declares `signals`.** The helper is inert, the surface behaves as it
  does today, and the runtime polls nothing.

## Conformance — what ships TODAY

Stated plainly, because a contract that overstates its own implementation is a
defect this repository has already paid for twice.

| specified | shipped |
|---|---|
| `runtime.boot` process identity at `GET /api/contract` | **yes** |
| `/signal.js` serving `watchSignal` / `preserveAcross` / `deferWhileDirty` | **yes** |
| latch-on-first-observation, marker-backwards-is-changed, degraded reporting | **yes**, with controls |
| `?since=` on an observe verb | **not yet** — the reference runtime's verbs are fixture-backed and mint no marker. The consumer half is shipped and tested against a scripted transport |
| `signals` in `provider.json`, carried through composition | **not yet** |
| `preserve` accepted as contract on a surface row and carried to the shell | **yes** — schema and runtime validation kept in step by a committed test |
| the helper reading `preserve` from the row and driving capture/restore from it | **yes** — `declaredKinds` + `preserveDeclared`, with controls |
| `standardAdapter` binding `scroll`, `form` and `playhead` to real DOM | **WRITTEN, NOT YET VERIFIED.** The code exists and its RULES are under control — which kinds it claims, and which fields it refuses. Its DOM behaviour has not been exercised in a browser, and a test runner cannot exercise it. **Do not cite the code as evidence it works; this row flips on a browser pass, not on the code landing.** |
| `standardAdapter` handling `selection` | **no, by decision.** Across the surveyed applications `selection` means asset names, opaque canvas shape ids, absolute file paths and timeline slot ids — four types sharing only the word. A generic adapter picking one would be right for a single app and silently wrong for the rest, so `supports("selection")` is false, the declaring surface is told, and a surface that knows what its selection IS supplies that kind itself |

Rows here are measured against the shipped tools rather than recalled. A row that
moves to **yes** moves with the control that proves it.
