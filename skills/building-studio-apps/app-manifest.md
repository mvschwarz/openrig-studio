# app.json — declaring an app

One file beside your app's code. It is what lets a box install your app without a human
reading your README and guessing.

## Minimum — an ultralight app

```json
{
  "manifest_version": 1,
  "id": "notes",
  "name": "NOTES",
  "summary": "Scratch notes that live with the project.",
  "category": "create",
  "surface": {
    "entry": "app/notes.html",
    "path": "/surfaces/notes.html",
    "glyph": "▤",
    "hint": "jot and search"
  }
}
```

- **`entry`** — where the file lives in YOUR repo.
- **`path`** — where it is served on the rail. The composer copies `entry` → the overlay and
  serves it at `path`. These are two different things and conflating them is a common slip.
- **`glyph`** — one character. The rail is dense; an emoji will look wrong beside the others.

## A heavy app

A heavy app serves itself. It has no `entry` to copy — only a URL to point at.

```json
{
  "manifest_version": 1,
  "id": "beatline",
  "name": "BEATLINE",
  "surface": {
    "url": "http://127.0.0.1:8794/beatline.html",
    "glyph": "∿",
    "hint": "music-video beat timeline"
  }
}
```

**`path:` and `url:` are mutually exclusive.** `path:` means "the shell serves this file";
`url:` means "something else already serves it, just frame it."

## The fields that make it installable

Everything above makes an app *appear*. These make it *work* on a machine that is not yours.

```json
{
  "provider": {
    "package": "@example/my-provider",
    "required": true
  },
  "roots": {
    "project": { "required": true },
    "media":   { "required": true }
  },
  "verbs": ["/api/timelines", "/api/patch", "/api/probe-duration"],
  "vendor": ["tldraw-v5.2.5"]
}
```

| field | why it exists |
|---|---|
| `provider` | the backend your surface calls. **Omit it and installing your app yields an HTML file that 502s.** |
| `roots` | the KINDS of directory you need — not paths. The install binds kinds to real locations. |
| `verbs` | what you call. Makes the dependency auditable rather than discovered at runtime. |
| `vendor` | directories that travel with the app. Ship them; do not fetch from a CDN. |

### roots are KINDS, never paths

```json
"roots": { "media": { "required": true } }     ✅  the install binds it
"roots": { "media": "/Users/me/videos" }       ❌  works on exactly one machine
```

Every hardcoded path in the apps migrated so far existed because **nothing in the format ever
asked where the user's data lives.** Declaring kinds kills the whole class.

### Declare the closure; do not discover it

List what your app needs. Do not expect an installer to find it by scanning your imports — a
scan that matches `./` will miss `../../vendor/tldraw`, and the app will load to a spinner with
every verb returning 200.

**An app is not its surface file.** It is surface + backend + vendored deps + a resolved
closure + the roots it needs + first-run seeding.

## [producer] Where your surfaces actually live, and what the runtime will serve

Register from **outside** the package. Point the runtime at a directory you own:

```sh
node node_modules/@openrig/studio/app/serve-studio.mjs --surfaces ./surfaces
# or
OPENRIG_STUDIO_SURFACES=./surfaces npm start
```

That directory holds your pages **and** your own `surfaces.json`, using the same row schema.
Nothing is ever written into the package, so a copied `node_modules` cannot carry your
registrations — which is failure mode #8, removed structurally rather than mitigated.

Three consequences that will bite you if you assume otherwise:

**Serving follows registration, not the filesystem.** A file in your overlay is served **only**
when a valid row registers it. Dropping `notes.html` next to your manifest does not publish it —
it is a 404. So is anything else in that directory: a stray `secret.txt` is not reachable. The
overlay is a registration seam, not a static web root.

**A registered row whose page is missing fails as itself.** You get a 404 naming the problem, not
the package's page quietly substituted underneath your row. Row ownership and page ownership are
never allowed to disagree about whose surface you are looking at.

**Replacing a stock surface is an ID act, and it warns.** Reuse the id and your row wins with a
named warning in `manifest.warnings`. Reusing another row's `path` under a different id is
refused with an error instead — otherwise replacement would become a silent filename act.

**With an overlay configured, the runtime serves exactly what is declared** — the SDK's own
surfaces plus yours — and anything else in the installed package is ignored for serving and
reported in `manifest.warnings`. That guarantee covers surface state written *into* a package
(a copied tree, a stale materialisation, a dependency writing into `node_modules`). It does not
cover a dependency shipping a modified runtime source; that is supply-chain, a higher bar you
accept by installing at all.

## The test that matters

**Install the manifest somewhere that has nothing.**

A manifest written on a machine that already has everything will always under-declare — not
through carelessness, but because nothing forced it to be honest. The first app to fail this
way declared a surface and a screenshot, and its own verify step admitted the runtime provider
was "not shipped in this package." It was listed in a registry as installable. It was not.
