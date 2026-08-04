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

**The agent-sidebar roster.** This section previously said a consumer had no way to supply one and
that the SDK's own fixture seat reached every install. That was true and is now fixed; the old text
is replaced rather than annotated because it described a mechanism that no longer exists. Ask a
running studio what it actually does — `GET /api/contract` → `manifest.seats` reports the roster's
`source` — rather than trusting a package number written down here.

**What you get without doing anything:** if the studio belongs to a rig, the panel shows that
rig's seats — the one it belongs to, not every seat on the machine — each carrying a `status`, so
a configured agent that is not running stays listed rather than vanishing. If there is no rig, the
panel is honestly empty. It never falls back to the SDK's example seat.

**To supply your own roster,** declare `chatSeats` in your own `surfaces.json`. That declaration
wins entire, and an EMPTY array is a declaration too — "this studio ships without seats" — not an
absence. There is no merging: a roster is a statement about who is actually there, and a
half-invented one is worse than either half.

**Which rig, when it is not obvious:** declared in `studio.json` beats the managed session the
studio was started from, which beats the only rig on the box. Several rigs and nothing declared is
reported as ambiguous with the candidates named — it will not union them or pick the first.

**Check `GET /api/contract` → `manifest.seats`** for `{ count, source, attachable }`. `source` is
the field that matters: `"package"` while you have an overlay configured means your declaration
did not take.

**Terminal attach is authorized against the served roster**, not against the machine. The seat name
travels in the URL and is caller-controlled, so what the sidebar renders is a suggestion — the
boundary is the composed manifest the shell is served from, and a seat outside it does not attach.

**The fixture floor is fiction by design.** The SDK ships a `factory-state.json` describing an
invented rig, rendered under a live-activity header with a green dot. Correct as an SDK
example, actively misleading on a real box — generate the same contract from your real source
and point the runtime at that.
