---
name: building-studio-apps
description: Use when building, packaging, or registering an app, surface, or tab for the OpenRig Studio SDK (@openrig/studio) — including deciding whether an app needs its own server, why a surface loads but its panes stay empty, why a tab 404s or shows another project's data, or why an app that works on the machine that built it fails on a fresh install.
---

# Building Studio Apps

## What the SDK actually is

`@openrig/studio` is an **app shell and a contract** — a rail of tabs, a stage, an agent
sidebar, and a protocol for how a surface talks to them. It is **not a framework you import.**
Nothing in your app needs to `require` it.

That single fact determines everything else: your app can be plain HTML, Next.js, Go, Rust, or
a container. If it answers on a URL and conforms to the contract, it can be a tab.

**The shell is a directory + a frame + an agent bridge. You do not install an app INTO it.
You register a ROW.**

## The one decision that shapes everything

**Ultralight vs heavy is not about size. It is about WHO SERVES THE BYTES.**

| | ultralight | heavy |
|---|---|---|
| what it is | HTML + a script, riding verbs the shell already serves | brings its own server |
| registered as | `path: /surfaces/foo.html` | `url: https://…` |
| needs the SDK to run? | **yes — the shell IS its runtime** | **no — only to appear as a tab** |

**This inverts the intuitive reading and you will get it backwards.** The *small* app is the one
that genuinely depends on the SDK. The *big* one runs fine without it and only needs a row.

Consequence worth internalising: a heavy app just runs your service, adds a row, and gets the agent panel beside it — zero integration code.

## The three steps

1. **Install it** however that kind of software normally installs — git clone, npm, docker.
   The SDK has no opinion and no installer.
2. **Register a row** so it appears on the rail. → `app-manifest.md`
3. **Make it work**, which is a different claim from step 2 and is where the time goes.
   → `providers-and-roots.md`, `failure-modes.md`

## Read next

| file | read it when |
|---|---|
| `app-manifest.md` | writing `app.json`; declaring a provider, roots, or vendored assets |
| `shell-contract.md` | your surface needs to talk to the shell — focus, navigation, the agent sidebar |
| `providers-and-roots.md` | your app needs a backend, files on disk, or a binary like ffmpeg |
| `failure-modes.md` | **read this before you ship, not after.** Every entry is a real failure with the symptom you will actually see |

## The rule that saves the most time

**Verbs answering is not apps working, and only a browser catches the difference.**

Every API check can return 200 with real data while the pane renders empty — a field renamed, a
vocabulary the icon map does not know, a bundle that never loaded. This was the single most
common failure in building the first five apps.

**Open the app. Look at it. Click the thing.** A passing test suite is a shape that a working
app also produces.

## Versions: the package and the contract move separately

`@openrig/studio` is at **0.4.0**; the **contract is 0.1**. Those are different numbers on
purpose and you will trip on it once. Additive changes — new fields, new routes, the
consumer-surface seam — bump the package and leave `contractVersion` alone. A surface built on
stable items of contract 0.1 keeps working across package minors.

**Check compatibility the documented way:** capabilities present + same contract *major*. An
exact-match check on `contractVersion` is safe but over-strict and will refuse runtimes that are
guaranteed to work. Ask the running box:

```sh
curl -s localhost:<port>/api/contract | jq '{contractVersion, capabilities}'
```

## Status of this skill

Grounded in building and migrating the first five applications built on this SDK. Every failure mode listed is one that actually happened and was
measured, not anticipated.

**One skill, two authorship perspectives** — consumer-side and producer-side, deliberately not
two documents. The consumer half is the original and remains the spine: it is the half that knows
what actually goes wrong when you build on this thing. Producer additions are marked `[producer]`
and are limited to what the SDK side can state authoritatively — mechanism, version facts, and
which behaviours are contract rather than accident. Where the two would disagree, the measured
consumer experience wins and the producer note explains why the runtime does that.

If you are extending this: extend it here. A second copy in another repo is the drift this
placement exists to prevent.
