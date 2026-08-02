# Talking to the shell

**The contract ships inside the package. Read it there, not here** — restating it would create
a second source that silently drifts:

| document | in `node_modules/@openrig/studio/contract/` |
|---|---|
| the shell protocol, lifecycle, postMessage, the change-signal loop | `shell-protocol.md` |
| the row schema, field by field, with stability markers | `surface-row.schema.json` |
| the runtime's own verbs | `runtime-api.md` |
| what the contract version means | `contract-meta.md` |

Check the live contract of the box you are on:

```sh
curl -s localhost:<port>/api/contract | jq '{contractVersion, capabilities, manifest}'
```

## The short orientation

Your surface lives in an iframe and is **sovereign inside it**. The shell gives you four
things, and only four:

1. **A frame and a rail tab.** Registered by a row; `path` (shell serves it) or `url`
   (something else does) — exactly one, never both.
2. **A liveness dot**, from the shell polling your URL. You write no code for it. It means
   *answered HTTP*, nothing more — a dot is not evidence the app works.
3. **An agent sidebar** you may summon with `postMessage`.
4. **A change signal** (`GET /api/events`, SSE) — **a signal, not a data channel.** On any
   message, re-fetch what you care about. Do not parse payloads.

The surface→shell channel is a **closed** message set in v0.1 (`open-surface`, `open-agent`).
The shell ignores anything else; new types arrive as contract additions, not by surfaces
inventing them.

## Consumer-side notes the contract docs do not cover

**Your iframe is kept alive when backgrounded.** State and open connections survive a tab
switch. If your surface holds an attachment that must not persist invisibly — a terminal
client, a device handle — declare `unmountOnBlur: true` or a hidden instance will fight the
visible one.

**Declare `color-scheme: dark`.** The shell is dark; a light flash on load reads as broken.

**Show degraded states in the UI, not the console.** When something is wrong it must *look*
wrong. This is the same rule as `failure-modes.md` #4, stated by the contract itself.

**`chatSeats` had no consumer path at contract v0.1.** The runtime merges `surfaces[]` from a
consumer overlay and passes the rest of the document through, so a consumer's declared seat
roster was ignored and every install showed the SDK's own fixture seat in the agent sidebar.
Verify what your box actually serves before trusting the roster in that panel; a consumer front
that owns the origin can compose the real roster onto `/surfaces.json` itself. **Re-check
whether this is still true on your contract version** rather than assuming either way.

> **[producer] Answering that re-check, as of package `0.3.0` / contract `0.1`: STILL TRUE, and
> here is the mechanism so you can confirm it yourself rather than trust this line.**
> `/surfaces.json` is served as `{ ...packageDocument, surfaces: <merged rows> }` — the package
> document spread with only `surfaces` overridden. **The overlay document is never spread**, so
> overlay `chatSeats` is read by nothing and the package's fixture roster reaches every install.
>
> **The part that will cost you time: it fails silently.** Putting `chatSeats` in your overlay is
> the obvious move — it mirrors exactly how you register surfaces — and it produces no warning,
> no error, and nothing at `/api/contract`. A plausible path that does nothing.
>
> This is a known defect with a ruled fix pending, not a design intent. The likely shape is that
> the package roster stops leaking into consumer installs and `/api/contract` starts declaring
> that seats are package-sourced and **not** overlay-merged — so the obvious attempt hits a
> visible signal instead of silence. **Check `/api/contract` on your version before assuming
> either behaviour.**
>
> One correction to the workaround above: composing the roster onto `/surfaces.json` yourself
> works only if **you own the origin** — i.e. your own front serves that path. Under the SDK
> runtime you do not, so there is no consumer-side fix on this version; the honest move is to
> treat the sidebar roster as unreliable and say so in your UI rather than paper over it.
>
> The fixture seat **is labelled**: the sidebar renders it beside an explicit note that the
> reference runtime has no live seat backing. Wrong for a real box, but it is a labelled fixture,
> not a silent lie — do not report it as one.

**The fixture floor is fiction by design.** The SDK ships a `factory-state.json` describing an
invented rig, rendered under a live-activity header with a green dot. Correct as an SDK
example, actively misleading on a real box — generate the same contract from your real source
and point the runtime at that.
