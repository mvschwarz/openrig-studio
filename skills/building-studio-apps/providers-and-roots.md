# Providers, roots, and the closure

The gap between "my app appears on the rail" and "my app works."

## Do you need a provider?

A **provider** is the backend your surface calls. Decide with one question:

> Does my surface call any verb the shell does not serve?

Check what the shell actually gives you — `curl /api/contract` → `capabilities`. At contract
v0.1 that is a deliberately small set (contract meta, observe, an event stream, **read-only**
file access, the shell protocol).

- **No** → ultralight. No provider. You ride the shell's verbs.
- **Yes** → you need a provider, and **`app.json` must declare it.**

```json
"provider": { "package": "@example/my-provider", "required": true }
```

**Omit this and installing your app produces an HTML file that 502s.** That is not
hypothetical — an app can be listed as installable while its manifest declares only a surface and a screenshot, with no provider shipped in the package.

## Do not extract a "generic core" prematurely

When your provider grows, the instinct is to split the reusable half out. Resist it until a
**second consumer exists to show you where the seam is.**

Measured reason: hand-extracting a working backend broke three response contracts in one
afternoon, each returning 200 with real data while the pane rendered empty. Doing that
speculatively at 10× scale, with no second consumer, is the same operation with worse odds.

**Name it and package it as-is.** The seam reveals itself from demand.

## Roots are KINDS

Declare the kinds of directory you need. The install binds kinds to real paths.

```json
"roots": {
  "project": { "required": true },
  "media":   { "required": true }
}
```

Every hardcoded path found in the migrated apps — a specific project folder, one machine's working directory, `$HOME/studio/app` — existed for the same reason: **nothing in the format
ever asked where the user's data lives.** They were not sloppiness. They were a missing
convention, and declaring kinds removes the class permanently.

Corollary for your code: **parameterise the roots** (`--media-root`, `--project-root`) so
binding is configuration, not a patch.

## Declare the closure

List everything your app needs to run:

- the provider package
- vendored directories (`vendor: ["tldraw-v5.2.5"]`) — ship them; the box should not call a CDN
- binaries you shell out to (`ffmpeg`, `ffprobe`) — **name the binary AND the verb that uses
  it**, so the dependency is auditable and cannot quietly grow by analogy
- first-run seeding, if your app needs a scaffolded project to be usable

**Do not expect an installer to discover this by scanning your imports.** A scan matching `./`
misses `../../vendor/…`, and the result is an app that loads to a spinner with every verb
returning 200.

## First run

An app whose backend answers `ENOENT` on a fresh box is honest but unusable. Decide explicitly
which you are shipping:

- **honestly empty** — no data yet, and a *working way to add some*. This is fine.
- **stub empty** — returns `[]` regardless of what is on disk. This is not.

If your app needs a project structure to exist, seed it with the product's **own** scaffolder.
Hand-writing a plausible-looking data file gives the app something that parses and then behaves
wrong.

## Serving your own documents

If your surface needs to read your project's files, **serve them from your provider over
`/api/…`.** Do not let the surface fetch them as siblings, and do not read them through some
other backend's file verbs.

Both shortcuts work on the machine you are testing on and fail elsewhere:

- the sibling fetch works only while something serves your page from inside your data directory
- another backend's file verbs work only while your data happens to sit inside *its* configured
  roots

The document belongs to the provider that owns it. **The path should be server-derived** — a
read verb that takes no caller-supplied path cannot be pointed somewhere it should not go, and
needs no validation to prove it.
