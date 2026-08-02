# The surface manifest — how a surface registers

contractVersion: 0.1

The manifest is `app/surfaces.json`. The shell renders its rail from it; the
runtime validates it. One row in `surfaces[]` = one surface = one door.

There are two registration paths, and which one you want depends on whose
surface it is:

| You are… | Use |
|---|---|
| adding a surface **to this SDK itself** | *Registering a surface* below |
| **building a studio ON the SDK** and adding your own surface | *Registering surfaces as a consumer* below |

If you installed this SDK as a dependency, you are the second case. Its `app/`
directory is inside `node_modules` — gitignored, destroyed by `npm ci`, and
carried by any copy of the tree. **Do not put your surfaces there.**

## Registering a surface (the whole procedure)

This is the path for surfaces owned by the SDK itself.

1. Put your surface page under `app/surfaces/` (e.g. `app/surfaces/mine.html`).
   It is served same-origin at `/surfaces/mine.html`.
2. Add one row to `surfaces[]` in `app/surfaces.json`:

```json
{ "id": "mine", "name": "MINE", "glyph": "◆", "path": "/surfaces/mine.html",
  "hint": "one line about what this surface is" }
```

3. Reload the shell. Your surface appears on the rail. That is the entire
   registration surface — there is no build step and no other file to touch.

**Rediscovery semantics (v0.1):** the **runtime** re-validates the manifest
live whenever the file changes — `GET /api/contract` reflects an edit within
about a second, no restart needed. The **shell**, however, reads the manifest
once at load: an already-open shell tab does **not** rediscover new or changed
rows — reload the shell tab to see rail changes. Live rail rediscovery is a
candidate contract addition, not an unstated current behavior.

Field semantics and stability marks: `surface-row.schema.json` (each property
carries a `description` and an `x-stability` mark). Required: `id` (unique),
`name`, and exactly one of `path` (must start with `/`) or `url`.

## Registering surfaces as a consumer (stable)

If you are building a studio **on** this SDK, your surfaces are yours: they live
in **your** repository, are versioned by **you**, and are never written into the
installed package.

Point the runtime at a directory you own:

```sh
node node_modules/@openrig/studio/app/serve-studio.mjs --surfaces ./surfaces
# or
OPENRIG_STUDIO_SURFACES=./surfaces npm start
```

That directory holds your pages **and** your own `surfaces.json`, using exactly
the row schema documented here:

```
surfaces/
  surfaces.json      { "surfaces": [ { "id": "mine", "name": "MINE", "path": "/surfaces/mine.html" } ] }
  mine.html
```

Your pages are served at `/surfaces/<file>`, the same URLs as any other surface.

**Merge and precedence.** The rail is the SDK's own surfaces followed by yours.
If you reuse an id, **your row wins** — that is how you deliberately replace a
stock surface — and the runtime emits a warning naming the shadowed id, so a
replacement is never silent.

**Serving follows registration, not the filesystem (stable).** A file in your
overlay directory is served only when a **valid row registers it**. Putting a
file there does not publish it: an unregistered file is a 404, and it never
outranks a registered package page. If you register a row whose page is missing,
that path returns **404 naming the problem** — the package's page is not
substituted underneath your row, because then the rail and the bytes would
disagree about whose surface you are looking at. Replacing a stock surface is
done by **id**, which warns; it is not done by filename, which would be silent.

**With the seam active, the runtime serves exactly what is DECLARED (stable).**
That is: the SDK's own declared surfaces, plus the surfaces your overlay
declares, and nothing else.

The SDK's own set is declared **in its runtime source**, not in
`app/surfaces.json`. That is deliberate. The failure this seam removes is
contamination *of the installed package* — a copied tree, a stale
materialisation, a dependency writing into `node_modules` — and every one of
those mutates the manifest and the surfaces directory. Rooting the SDK's
authority in the file the contamination writes to would make an injected row
authoritative by construction.

So, when an overlay is configured:

- a row in the package manifest that the SDK does not declare as its own is
  **ignored for serving and reported in `manifest.warnings`**
- a file under the package's `app/surfaces/` not backed by a served declared row
  is **not served and reported the same way**

Contamination is made **visible**, not silently dropped — an operator learns the
installed package is dirty rather than merely not seeing a surface.

**Scope of that guarantee, stated so it is not read as more than it is.** It
covers surface state written *into* an installed package. It does **not** cover
a dependency that ships a **modified runtime source**: that is a supply-chain
compromise, a different and higher-bar class, and it is already accepted by the
act of installing the SDK at all.

**Zero config is unaffected.** With no overlay configured none of the above
applies and the package manifest is served exactly as it always has been.

**Validation** is the same warn-first contract, applied per source. With an
overlay configured, errors and warnings are prefixed with which manifest they
came from (`package` / `consumer`), because a bare `surfaces[0]` no longer says
enough. Without an overlay the messages are unchanged.

**Per-source health** appears at `GET /api/contract` under `manifest.consumer`
— its own `state`, `reloads`, `recoveries` and `integrityReloads`, with the same
meanings as the top-level fields (which describe the SDK's own manifest). It is
`null` when no overlay is configured.

**Why the seam exists, not just how.** The registration path above is inside the
package. In a consumer install that is `node_modules/@openrig/studio/app/` —
gitignored, wiped by `npm ci`, and, worst of all, **carried by a copy**:
duplicating a `node_modules` tree duplicates any surface state inside it, so a
copied deployment can serve a healthy manifest with the wrong surfaces. Because
consumer surfaces never live in the package, copying it cannot carry them and
there is nothing to reconcile. The runtime writes nothing into your overlay
directory and copies nothing out of it.

**Zero config stays zero config.** With no `--surfaces` and no
`OPENRIG_STUDIO_SURFACES`, everything above is inert and the SDK's own surfaces
behave exactly as they did before this seam existed. The overlay is opt-in.

## Validation — warn-first (stable behavior)

The runtime validates the manifest at startup and re-validates when the file
changes. The behavior is **warn-first**:

- Rows that fail a required check are **excluded from the served rail** and
  named, row-by-row, in `GET /api/contract` → `manifest.errors[]` and in the
  runtime's startup log.
- Unknown fields are **warnings**, never errors — forward-compatibility is
  deliberate.
- The runtime keeps serving throughout. A malformed manifest never kills the
  runtime; it becomes visible instead.

Check `GET /api/contract` after editing the manifest. If your row does not
appear on the rail, the reason is spelled out there.

## Populations that are not the app-facing schema

`surfaces.json` may also carry runtime-owned state:

- `chatSeats[]` — the agent-sidebar roster (`{seat, name}` rows). The shell
  renders it; surfaces may summon it (see `shell-protocol.md`). Surfaces do
  **not** write it, and it is not part of the surface-row schema.
- `_note` — a human/agent-facing comment field. Ignored by the runtime.

## The example fixture posture

The reference runtime ships with one surface, FLOOR, which renders the fixture rig state. Your first surface's row goes beside it. The fixture data behind the runtime's API verbs
(`fixtures/`) is already populated, so a new surface has real data to render
on its first load.
