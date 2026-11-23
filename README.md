# OpenRig Studio

A browser shell for working beside your coding agents. The rail on the left holds **apps**, the app you're using sits
in the middle, and your agents' own terminals sit on the right, so an agent can change the thing you're looking at
while you watch. An app is one HTML page plus, when it needs one, a small server called a **provider**. This
repository is the SDK: the shell, the contract apps speak, a launcher that runs apps and their providers behind one
origin, and tools to install and upgrade them. Point your coding agent at it and it can build you an app.

Requires Node 22 or later. No build step. The release and install tools (`tools/studio-release.mjs`, and
`tools/install-app.mjs --enable`) also need Python 3: `python3` on `PATH`, or its path in `STUDIO_RELEASE_PYTHON`.

## Start here

| You want to | Do this | What you get |
|---|---|---|
| See the shell | `node app/serve-studio.mjs`, then open http://127.0.0.1:8890/ | the shell in demo mode: a made-up team on Floor, marked as example data |
| Run a real small app | `OPENRIG_STUDIO_DIR=examples/studio-quickstart node tools/studio.mjs` | **Notes**: one page, one provider, one bound folder ([example](examples/studio-quickstart/)) |
| Build your own app | copy the quickstart, or `node create-studio/index.mjs my-surface` | your app on the rail |
| Work with your OpenRig team | add `"rig": "<your-rig>"` to `studio.json` (needs OpenRig running and `ttyd`) | your agents' real terminals beside your apps |
| Keep it across upgrades | `npm ci`, then `node tools/studio-release.mjs plan …` | your apps, config and data kept, shipped files replaced |

**[docs/getting-started.md](docs/getting-started.md) walks through all five**, with what each file is for.

The maintained apps live in the separate `openrig-studio-apps` repository: Hello (the smallest app and provider, to copy
from), Canvas, Projects, Files, Machine, Rig designer and Terminal. Point `appsRoot` in `studio.json` at a checkout of it
and enable the ones you want. Its README says what each app does and needs; Terminal needs only
[ttyd](https://github.com/tsl0922/ttyd) installed, because a local Studio starts its shell itself.

## Know before you rely on it

- **A Studio shows real data or says it's unavailable.** The launcher always adds the SDK's own Floor app. It shows
  your real team when an app's provider supplies live team state (the Files app's provider does), and otherwise says
  the state is unavailable. Example data appears only in demo mode (`"mode": "demo"`, and the bare
  `app/serve-studio.mjs`), marked as such.
- **`npm create @openrig/studio` isn't published.** Use `node create-studio/index.mjs` from this checkout.
- **The agent panel opens real terminals.** Choosing an agent shows its live session, and what you type goes to it.
  Declare `"chatSeats": []` in the Studio's `surfaces.json` to ship a Studio with no agents.

## Where everything is

| Path | What it is |
|---|---|
| `contract/` | **The contract: start with `contract-meta.md`.** Manifests, shell protocol, runtime verbs, the agent primitives, release descriptors. |
| `skills/building-studio-apps/` | **If you are a coding agent, load this first.** Orientation and the failure modes, written for this job. |
| `examples/studio-quickstart/` | A complete small Studio with one app and its provider, plus `check.mjs`, which runs it end to end. |
| `create-studio/` | The scaffolder: a working single-page app wired to the contract. |
| `tools/studio.mjs` | The launcher: composes the rail from `studio.json`, runs providers, owns the one origin, attaches agent terminals. |
| `tools/install-app.mjs` | Installs an app into a Studio, refusing a manifest that can't describe a working install. |
| `tools/studio-release.mjs` | Creates, plans, applies and rolls back versioned Studio workspaces. |
| `app/` | The runtime (`serve-studio.mjs`) and the shell (`shell.html`). |
| `fixtures/` | The example data behind fixture mode. |
| `test/fixtures/annotations-app/` | A test fixture, not published with the package: an app (documents and canvases) that consumes the annotation seams, so the SDK's tests exercise them with a real consumer. The maintained app for this is Canvas, in the Studio Apps repository. |

**The SDK is a shell and a contract, not a framework you import.** Every app registers and calls verbs the same
way, with no privileged access to the runtime.

## Building an app

Read `contract/contract-meta.md` first; it explains how to read the rest. Then:
- `contract/app-manifest.md`: how an app declares its page, provider, root kinds and verbs;
- `contract/shell-protocol.md`: what the shell gives a page;
- `contract/runtime-api.md`: the runtime's HTTP verbs and their shapes.

Three opt-in primitives let an agent work with your app:
- `contract/change-signal.md`: stay fresh without losing what the user was doing;
- `contract/focus.md`: let an agent know what the user is looking at;
- `contract/drive.md`: let an agent operate the app.

`contract/annotations.md` covers marking up a screen together. A running Studio describes itself at
`GET /api/contract`. **The contract is the authority; the skill is the fast path into it.** Where they disagree, the
contract wins and the skill has a bug.

## Status

Pre-release. For the package version, run `npm pkg get version` in this checkout. Contract v0.1, which moves only
on a breaking change. Release notes:
[docs/whats-new.md](docs/whats-new.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm ci` once, then `npm test`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
