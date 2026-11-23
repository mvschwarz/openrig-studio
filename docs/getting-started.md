# Getting started with OpenRig Studio

Studio is a browser shell for working beside coding agents: a rail of apps on the left, the app you're using in the
middle, and your agents' own terminals on the right. An **app** is a page plus, when it needs one, a small server
(a **provider**). The SDK gives you the shell, the contract apps speak, a launcher that runs apps and their providers
behind one origin, and tools to install and upgrade them.

This guide goes from nothing to a Studio with your own app, connected to your OpenRig team. Every command here runs
from a checkout of this repository with Node 22 or later. Steps 1 to 5 install nothing; the release tool in step 6
needs one dependency, so run `npm ci` once in the checkout first, and Python 3 (`python3` on `PATH`).

| Step | You get | Needs |
|---|---|---|
| [1. Look around](#1-look-around-demo-mode) | the shell with labelled example data | Node |
| [2. Run the quickstart app](#2-run-the-quickstart-app) | a working app with its own provider | Node |
| [3. Make your own app](#3-make-your-own-app) | your app on the rail | Node |
| [4. Add apps from openrig-studio-apps](#4-add-apps-from-openrig-studio-apps) | maintained apps beside yours | Node 22, a second checkout |
| [5. Connect your OpenRig team](#5-connect-your-openrig-team) | your agents' terminals beside your apps | a running OpenRig rig, `ttyd` |
| [6. Keep it across upgrades](#6-keep-it-across-upgrades) | your apps and config survive SDK updates | the release tool |

## 1. Look around (demo mode)

From the repository root:

```sh
node app/serve-studio.mjs
```

Open http://127.0.0.1:8890/. The rail has one app, **Floor**, showing a made-up team called `fixture-rig` and marked
**Demo · example data**. Everything in this mode comes from `fixtures/`; nothing is connected to a real agent.
Editing a file in `fixtures/` updates the page live, which is a quick way to see the change signal working. Stop it
with Ctrl-C.

## 2. Run the quickstart app

[`examples/studio-quickstart/`](../examples/studio-quickstart/) is a complete small Studio: one app, **Notes**, that
reads the Markdown files in one folder through its own provider.

From the repository root:

```sh
OPENRIG_STUDIO_DIR=examples/studio-quickstart node tools/studio.mjs
```

Open http://127.0.0.1:8890/ and choose **NOTES** on the rail. Add a `.md` file to `examples/studio-quickstart/notes/`
and press Refresh: it appears. An agent reads the same data over HTTP from the same origin:

```sh
curl http://127.0.0.1:8890/api/notes
curl "http://127.0.0.1:8890/api/notes/item?name=welcome.md"
```

To check the example end to end without opening a browser (it runs a temporary copy on its own ports, so the Studio
above can keep running), from the repository root:

```sh
node examples/studio-quickstart/check.mjs
```

> **Floor is on the rail too, saying "Rig floor state unavailable".** The launcher always adds the SDK's own Floor
> app. A Studio shows real data or says it's unavailable, never sample work: Floor shows your team when an app's
> provider supplies live team state (the Files app's provider does, in step 4). To see examples instead, set
> `"mode": "demo"` in `studio.json`; every page then marks them as example data.

What the example is made of, and why each piece is there:

| File | Role |
|---|---|
| `studio.json` | the Studio: which apps are enabled, where they are (`appsRoot`), its port (the runtime takes `port + 1`), and which real folder each **root kind** means here (`"notes": "./notes"`) |
| `surfaces.json` | `{"chatSeats": []}`: this Studio shows no agents. Remove it to connect a team (step 5) |
| `apps/notes/app.json` | the app's manifest: its page, the root kind it needs, the verbs it calls, the provider it needs |
| `apps/notes/app/notes.html` | the page: one self-contained HTML file, no build step |
| `providers/studio-notes/provider.json` | how the launcher runs the provider (`{{port}}`, `{{root:notes}}`) and which verbs it answers |
| `providers/studio-notes/notes-server.mjs` | the provider: two read-only GET verbs over the bound folder |

The rules that matter, all from [`contract/app-manifest.md`](../contract/app-manifest.md):
- An app never hardcodes a path. It declares a **root kind** (`notes`) and the Studio binds it to a real folder.
  Root kind names are lowercase letters only (`[a-z]+`).
- A provider declares the verbs it answers; the launcher routes only those to it. A verb the app calls but no
  provider declares answers 404.
- The launcher refuses to start when two providers claim the same verb, rather than routing one by accident.

**Ports.** `port` in `studio.json` is the address you open. The runtime behind it takes the next one, `port + 1`, and
each provider and the seat terminals take free ports above that, stepping over any port something else is serving. A
second Studio on the same machine needs both its `port` and `port + 1` free; the two Studios' providers step around
each other.

**Paths in `studio.json`** (`appsRoot`, `roots`) may be relative: they resolve against the Studio's own folder,
wherever you start the launcher. `appsRoot` is the folder that **contains** `apps/` and `providers/`. A module or
asset several of your apps share can live in `<appsRoot>/vendor/<name>`; each app lists the names it uses in
`vendor` (see [`contract/app-manifest.md`](../contract/app-manifest.md)).

## 3. Make your own app

**Copy the example** and rename: `apps/notes` → `apps/<your-id>`, set `id` in its `app.json`, add the id to `apps` in
`studio.json`, and replace the page and provider with yours. An app with no server needs no provider: omit
`provider` and `calls`, and call the runtime's own verbs (`GET /api/contract` lists them).

**Or scaffold a single page** with the scaffolder, starting from the repository root:

```sh
node create-studio/index.mjs my-surface --dir ~/studios
cd ~/studios/my-surface
node <path-to-this-repo>/app/serve-studio.mjs --surfaces .
```

It writes a page wired to the change signal, focus and drive primitives, a manifest row, and a `studio.json`, so
`OPENRIG_STUDIO_DIR=. node <path-to-this-repo>/tools/studio.mjs` runs it too. The npm form
(`npm create @openrig/studio`) is **not published yet**; use the command above.

**If you are a coding agent**, load [`skills/building-studio-apps`](../skills/building-studio-apps/) before writing
an app. It leads with the decision that shapes everything (does the app need its own server?) and the failure modes
that are hard to see from the contract alone.

## 4. Add apps from openrig-studio-apps

The maintained apps live in a separate repository,
[`openrig-studio-apps`](https://github.com/mvschwarz/openrig-studio-apps). [Its README](https://github.com/mvschwarz/openrig-studio-apps#readme)
says what each app does and which provider it needs, and has a `studio.json` that enables them all. Clone it, point `appsRoot` at that checkout (the
folder containing its `apps/` and `providers/`), and list the apps you want in `apps` by their ids, the folder names
under its `apps/`:

| Id | On the rail | What it is |
|---|---|---|
| `hello` | Hello | the smallest app and provider, to copy from |
| `canvas` | Canvas | documents and canvases you and an agent build together |
| `workspace` | Projects | one screen over your rig's agents, the apps installed here and your files |
| `files` | Files | browse, search, tag and edit the folders you give the Studio |
| `system` | Machine | how full this machine is, and a few safe cleanups |
| `rig-designer` | Rig designer | design an OpenRig rig by talking to an agent |
| `terminal` | Terminal | a terminal on your machine, inside the Studio (needs `ttyd`) |

Bind two root kinds in `roots`: `project` is the folder Files opens (and Machine never cleans), and `artifacts` is
where Canvas keeps its documents. The Files app's provider also supplies live team state, which is what Floor shows.

A Studio reads apps from one `appsRoot`. To add your own app to it, copy your provider folder into its `providers/`,
then install the app, which checks the manifest and its provider before copying anything. From the repository root,
with your app in `my-studio/`:

```sh
cp -R my-studio/providers/studio-notes <appsRoot>/providers/
OPENRIG_STUDIO_DIR=<your studio> node tools/install-app.mjs my-studio/apps/notes --enable
```

`--enable` adds the app to `studio.json`. Restart the Studio and open the app: installed is not the same as working.

## 5. Connect your OpenRig team

Studio reads your team from OpenRig itself: it never starts, stops or reconfigures agents.

Prerequisites: OpenRig installed with its daemon running (`rig ps` lists your rig), and
[`ttyd`](https://github.com/tsl0922/ttyd) on your `PATH` for terminals in the browser. This step was checked with
OpenRig 0.7.21.

1. Remove `surfaces.json` from your Studio folder (or delete its `chatSeats` line).
2. Name the rig in `studio.json`: `"rig": "<your-rig>"`. Without it, the launcher uses the rig of the agent it was
   started from (`rig whoami`), and refuses to guess when that's ambiguous. A Studio with a server hook never guesses:
   it needs the rig named here.
3. Start the Studio. The boot line says what it found, for example
   `seats : 12 seat(s) from rig my-rig (5 running) [rig] · terminals through /chat (ttyd on a private Unix socket)`.

The **AGENTS** panel lists every member of that rig with its state; one that isn't running stays listed rather than
disappearing. Choosing an agent opens **its real terminal** beside your app: what you type goes to that agent. With
no `ttyd`, agents are listed but not attachable, and the boot line says so. Terminal access is authorized against
the same roster the panel shows, so a Studio can't attach to a seat outside its rig.

To ship a Studio deliberately without agents, keep `{"chatSeats": []}`: an empty list means "no agents here",
not "not configured".

To make sure a Studio never asks OpenRig at all, set `"rig": false` in `studio.json`. It never runs the `rig` command
(no `rig whoami`, no `rig ps`), so a box whose `PATH` happens to reach someone else's rig never reads or logs it. A
roster the Studio declares itself (`chatSeats`) still applies.

**A shell terminal** starts with the Studio when [ttyd](https://github.com/tsl0922/ttyd) is installed: the Studio runs
`tools/start-terminal.mjs shell` itself, on a private socket under the Studio folder's `.runtime/terminal/` (or, when
that path would be longer than a Unix socket allows, about 100 bytes, in a private folder of this Studio's own in the
temp directory, `openrig-studio-<id>`), and the terminal opens at `/terminal/`. Without ttyd, `GET /api/studio/place` says the terminal isn't set up. To run the listener yourself instead
(on another socket, or under your own supervisor), set `STUDIO_TERMINAL_SOCKET` before starting the Studio; a configured
socket always wins:

```sh
export STUDIO_TERMINAL_SOCKET="$HOME/.studio-terminals/shell.sock"
node tools/start-terminal.mjs shell
```

It prints `Terminal ready: /terminal/` once its private socket is listening. The socket path must be absolute and at most
100 bytes, in a folder you own; a longer one is refused before anything starts.

**The full team view** (an existing Herdr session) is a separate, optional listener you start yourself:
`tools/start-terminal.mjs team`, with `STUDIO_TEAM_SOCKET`. [`contract/app-manifest.md`](../contract/app-manifest.md),
"Shell and existing team terminals", has the variables.

**Who can use a local Studio.** A Studio started this way answers only this computer, and treats whatever reaches it as
you, the owner, shell terminal included. That means every account on this computer: like one shared workspace, it
doesn't tell this computer's users apart, so run it where you trust the other accounts. The web pages you visit can't
use it: it answers only its own address, takes changes and terminal connections only from its own pages, and only its
own pages may frame it. To let anyone else in, from this computer or another, put a sign-in in front of it with server
hooks ([`contract/server-hooks.md`](../contract/server-hooks.md)). If another app serves the Studio's pages from its own
address, list that app's origin in `STUDIO_ALLOWED_ORIGINS`.

## 6. Keep it across upgrades

Run `npm ci` once in this checkout (the release tool uses `semver`). Then `tools/studio-release.mjs` creates and
upgrades a Studio workspace from a release descriptor ([`contract/release.md`](../contract/release.md)). It replaces
shipped files and keeps what you own: `extensions/` (your apps and providers, in `extensions/apps/<id>` and
`extensions/providers/<name>`), `project/`, `data/` and your settings in `studio.json`. The one setting it manages is
`appsRoot`:
- **Creating a workspace** writes the first `studio.json`, pointing `appsRoot` at the managed apps.
- **Bringing an existing, unversioned Studio under the tool** changes only `appsRoot`, to the managed apps, and only
  if it still holds the value the tool expects. Every other setting stays. Rolling that back puts the old value back.
- **Upgrading** a managed workspace leaves `studio.json` as it is.

From the repository root:

```sh
node tools/studio-release.mjs inspect --workspace <dir>
node tools/studio-release.mjs plan    --workspace <dir> --release <descriptor.json>   # inert: says what would change
node tools/studio-release.mjs apply   --workspace <dir> --release <descriptor.json>
node tools/studio-release.mjs rollback --workspace <dir>                              # code only; config and data stay
```

`plan` reports local edits to shipped files ("drift"). They are never overwritten silently: `apply` needs your
decision, and `--keep-local` keeps them. Run `node tools/studio-release.mjs --help` for the full set.

## Where to go next

- [`contract/contract-meta.md`](../contract/contract-meta.md): how to read the contract, then the three agent
  primitives: [change signal](../contract/change-signal.md), [focus](../contract/focus.md), [drive](../contract/drive.md),
  and [annotations](../contract/annotations.md).
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): how to contribute.
- [`docs/whats-new.md`](whats-new.md): what changed in each release.
