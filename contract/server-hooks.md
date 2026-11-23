# Server hooks: who may use a Studio

contractVersion: 0.1

A Studio (`tools/studio.mjs`) owns one origin. By default it answers **only this computer**. A deployment that admits people
another way, such as a sign-in in front of a hosted box, installs **server hooks**: one module that decides every request and
WebSocket upgrade, and can add to what the Studio shows. The SDK carries no particular sign-in.

## The default: loopback only

With no hooks, every request and upgrade must carry a `Host` of `127.0.0.1`, `localhost` or `[::1]` on the Studio's own port.
Anything else gets `403`.

- **Why the Host:** a web page the owner visits can point its own name at 127.0.0.1 (DNS rebinding), but it still sends its own
  `Host`.
- **Reached another way:** a box reached through an SSH forward on another local port, or a proxy that keeps its public `Host`,
  lists those exact values in `STUDIO_ALLOWED_HOSTS` (comma-separated, as the browser sends them).
- **The person:** every admitted request is the local owner: `{ "workspace": "full", "access": "owner" }`.

**Changes and upgrades come only from the Studio's own pages.** A page on another site can't read a loopback Studio, but it can
still send the owner's browser there with a form or a fetch, and that request carries a loopback `Host`. So every request whose
method isn't `GET`, `HEAD` or `OPTIONS`, and every WebSocket upgrade, must also pass this rule, or it gets `403` with a one-line
reason (an upgrade gets a `403` and a closed socket):

| The request carries | Admitted when |
|---|---|
| an `Origin` | it is one of `STUDIO_ALLOWED_ORIGINS`, or it is this Studio's own address (`http://` or `https://` plus the admitted `Host`) and `Sec-Fetch-Site` doesn't say another site sent it |
| no `Origin`, but `Sec-Fetch-Site` | it is `same-origin` or `none` |
| neither header | always: that is curl, a script or another local tool, not a browser page |

- **`Origin: null`** (a sandboxed frame, a local file, a redirect from another site) is never admitted.
- **`same-site` is treated as `cross-site`.** For a loopback address the site is the bare host: every other port on
  127.0.0.1 (any local dev server, any other app) is the "same site". It earns no trust. `127.0.0.1` and `localhost` are
  different sites to the browser, so a page on one sending to the other is `cross-site`.
- **`STUDIO_ALLOWED_ORIGINS`:** comma-separated exact origins (scheme, host and port; no path), for a host that serves the Studio's
  pages from its own address and forwards the browser's `Origin`. OpenRig's own Studio UI does this: it proxies a Studio's
  requests with the browser's UI `Origin` and a `Host` of `127.0.0.1:<port>`, so it sets `STUDIO_ALLOWED_ORIGINS` to its UI's
  origin; without it, every app's change made through that UI is refused. Anything that isn't an `http` or `https` origin is
  dropped. A listed origin is trusted however the browser sent it. The boot log's `door` line counts them.
- **Reads** (`GET`, `HEAD`, `OPTIONS`) need only the `Host`: the browser doesn't let another site read the answer.
- **The terminals and `/chat`** use the same list: their WebSocket's `Origin` must be this Studio's own address or a
  `STUDIO_ALLOWED_ORIGINS` value.

**Framing.** The shell page (`/`), `/terminal/` and `/team/`, and every `/chat` answer may be framed only by this Studio's own
pages (`content-security-policy: frame-ancestors 'self'`, and `X-Frame-Options: SAMEORIGIN` on the shell and terminals), so
another site can't put the owner's shell in a frame of its own and trick clicks or keys into it. The shell's own frames are
same-origin and unaffected.

**Who a local Studio trusts.** A loopback-only Studio treats whoever reaches its port as the owner, shell terminal included. That
is **every account on this computer**: the `Host` and `Origin` are sent by the client, so the Studio can't tell this computer's
users apart, the same as one shared workspace. Run it on a computer whose accounts you trust, or put server hooks in front.
What the gate keeps out is everything off this computer and the web pages the owner visits. The child key (below) does not
separate local accounts either; it keeps pages and stray tools from going around the gate.

## Installing hooks

Name an ES module in `studio.json`:

```json
{ "serverHooks": "hooks/door.mjs" }
```

- **The path:** relative to the studio folder. `STUDIO_SERVER_HOOKS` is read when `studio.json` names none.
- **Hooks replace the loopback gate.** The two never run together, so a hook that admits by cookie must make its own check that
  a change came from its own pages (an `Origin` rule, as above): the SDK adds none behind hooks.
- **A named module that can't be loaded, or that returns something malformed, stops the boot** (exit 1). A Studio never falls
  back to the loopback gate: on a box reached through a tunnel, the tunnel's requests can carry a loopback `Host`.

The module's default export is `install(ctx)` (it may be async):

| `ctx` field | What it is |
|---|---|
| `env`, `config` | The process environment and the parsed `studio.json` |
| `studioDir`, `runtimeDir` | The studio folder and its `.runtime/` |
| `surfaces()` | The surface ids this box composes, `"floor"` (the SDK's own) first. Read from the composed rail on each call |
| `log(line)` | One line in the Studio's boot log |
| `route(req, res, url, principal)` | Serve an admitted request, for a hook that runs its own listener (a private socket, say) |
| `upgradeRoute(req, socket, head, principal)` | The same for a WebSocket upgrade |

It returns:

```js
{
  describe: "one line for the boot log",
  admission: {
    http(req, res, next) {},                // call next(principal), or answer the request yourself
    upgrade(req, socket, head, next) {},    // call next(principal), or write a refusal and end the socket
  },
  transformShell(html, { principal, surfaces, served }) {},   // optional: returns the shell page's HTML
  place(principal) {},                                 // optional: returns { label?, account? }
  onHealth({ ok, children, method }) {},               // optional: hears each /healthz answer
  child: { env() {}, nodeArgs() {}, headers() {} },    // optional
  close() {},                                          // optional: called on SIGINT/SIGTERM
}
```

## The seams

**Admission (required).**
- **What it covers:** every request except the health check, and every upgrade.
- **When it admits:** it calls `next(principal)` with a principal object. `next()` or `next(null)` admits no one: the request
  gets `403` and the upgrade a `403` and a closed socket.
- **When it refuses:** it answers the request (redirect, `401`, `403`) or ends the socket itself.
- **When it fails:** an admission that throws or returns a rejected promise is a refusal, never a pass: the request gets `503`
  (or, once its answer has begun, a closed connection) and the upgrade a `503` and a closed socket. The Studio keeps serving.
- **Before admission:** a request line that isn't a URL (`GET //x:99999/a`, say) gets `400`, or a closed socket for an upgrade.
  No one request can stop the Studio.
- **Headers:** admission **may rewrite the request's headers** before calling `next`, for example to drop cookies or to add an
  identity header for apps. The Studio forwards the headers to the runtime and providers **unchanged**, so what apps read is
  what admission wrote.

**The principal** is what the Studio itself reads about the admitted person:

| Field | Meaning |
|---|---|
| `workspace` | `"full"`, or `"files"` for a files-only guest. A files-only guest gets no terminals and no upgrades |
| `access` | `"owner"`, `"collaborator"`, `"evaluator"`, or `null` |
| `email` | Optional, for log lines |
| `exp`, `session`, `sessions` | Optional. They let a long-lived tunnel close when this person's sign-in ends: `sessions` is `{ check(epoch), register(epoch, onClose) → unregister }` |

**The health check** (`GET`/`HEAD /healthz`) is never gated: a supervisor must always be able to ask it. Its status is
`200` when every child is up and listening, else `503`. What the body says depends on who asks:
- **This computer, on a loopback-only Studio:** `{ ok, children }`, where `children` lists each child the Studio runs: its
  kind, label, pid and port, whether it's up and listening, when it started, its recent restarts and last exit. That is a request whose
  `Host` is a loopback name on the Studio's own port, or a `STUDIO_ALLOWED_HOSTS` value.
- **Behind server hooks:** `{ ok, children }` to anyone only when the box sets `STUDIO_HEALTH_DETAIL=1` (for its own install checks); otherwise `{ ok }`.
  Such a box is usually reached through a tunnel or proxy, which can forward a public request with a loopback `Host`, so the `Host` proves nothing
  there, and admission is never run for a health probe. **`STUDIO_HEALTH_DETAIL=1` gives the children's labels, pids, ports and
  exit history to whoever reaches `/healthz`**, signed in or not: set it only where `/healthz` can't be reached from outside, or
  sits behind the box's own access control.
- **Anyone else:** `{ ok }` only. A web page the owner visits can point its own name at 127.0.0.1 (DNS rebinding) and read
  `/healthz`; it still sends its own `Host`, so it never learns which children run or on which ports.

**Health (optional).** `onHealth({ ok, children, method })` is called once after each `/healthz` answer has gone out: `ok`
is what the answer said, `children` is every child whoever asked (even when the answer itself said only `{ ok }`), and
`method` is `"GET"` or `"HEAD"`. It is never awaited, and a throw or a rejected
promise from it is swallowed, so it can't delay or change the answer (a heartbeat sent while the box is healthy, say).

**Shell transform (optional).**
- **When it runs:** for `GET`/`HEAD /`, the Studio reads the shell page from the runtime and passes it to
  `transformShell(html, { principal, surfaces, served })`.
- **What it may do:** add a name, links or navigation. `surfaces` lists the ids this box composes (as `ctx.surfaces()`
  does); `served` lists the byte-route prefixes a provider answers on this box now (for example `"/collab-assets/"`), so
  the hook can tell the shell what is there without asking the Studio's router.
- **Caching:** the result is served `no-store`, without an `ETag`.

**What the shell offers a hook** (`app/shell.html`, with or without a transform):
- **The chat panel:** the shell imports `/collab-assets/chat-panel/panel.js` (a provider that serves `/collab-assets/`
  provides it) and mounts it in the stage. `<meta name="openrig-chat-panel" content="none">` in the page turns that off:
  the panel isn't asked for, and with no seats declared the agents button is left out too. A transform adds the meta when
  `served` has no prefix for that path. Without the meta, a Studio that serves no panel gets one failed request for it,
  and the shell carries on with its own roster.
- **`#rail-private`:** an empty slot in the rail above its foot, hidden while empty, for a deployment's own control (a
  transform may fill it or place beside it).
- **Renewing a sign-in:** every 15 s, and when the tab comes back, the shell reads `HEAD /api/studio/place` without
  following redirects. A `403` with `x-openrig-front-door: renew` reloads the page (at most once per 30 s, with terminal
  frames released first so their leave-page prompt can't hold it); a redirect, `401` or other `403` shows one notice, "Your
  sign-in has ended", with "Sign in again"; an answer again removes it. So admission that ends a sign-in only has to refuse
  the read.

**Place (optional).** `GET /api/studio/place` answers `profile` (`"local"` or `"hosted"`), `workspace`, `access`, `label` and
`account`. `place(principal)` may supply `label` and `account`; it can't change `workspace` or `access`.
- **`label`:** a string, or `null` for a box with no name to show. Null is answered as `null`, never the Studio's own name.
  When the hook gives neither (or has no `place`), the label is `studio.json` `name`, else `"This Studio"`.
- **`account`:** a string, else `null`.

**Child processes (optional).**
- `child.env()` and `child.nodeArgs()` apply to every Node child the Studio starts: the runtime and providers.
- `child.headers()` is added to every request the Studio proxies to a child, for example a per-boot key that children
  demand, so nothing but this Studio reaches them on their own ports.

## A box that never runs the rig CLI

A Studio reads its seat roster from OpenRig (`rig whoami`, `rig ps`) at boot, before hooks load. A box that serves one
person may still have a `rig` command on its `PATH`, or OpenRig settings in its environment, that reach someone else's
rig. Such a box sets **`"rig": false` in `studio.json`**:

- the `rig` command is never run: no `rig whoami`, no `rig ps`, no roster read;
- the boot log says `rig : never attached here (studio.json "rig": false)`;
- a roster the studio declares itself (`surfaces.json` `chatSeats`) still applies.

It is independent of server hooks: a loopback-only Studio may set it too.

**A Studio with a server hook never guesses its rig.** A rig's roster is the list of seat terminals its visitors can
attach to, so with any hook installed only a declared `"rig"` (or `"*"`) counts. With none declared, no rig is attached
and the boot log says `choose a rig in studio.json ("rig": "<name>")`, naming the rig it was started from. Only the
loopback default infers its rig for its owner.

## The seat terminals at `/chat`

With a seat roster and `ttyd` installed, a Studio serves its agents' terminals at `/chat/?arg=<seat>` (see
`contract/manifest.md`, `chatSeats`), in every mode.

- **The listener:** ttyd listens on a Unix socket in a fresh `0700` folder this Studio makes in the temp directory, never
  on a TCP port: ttyd isn't one of the Studio's Node children, so the child key can't guard it. The folder is removed when
  the Studio stops. A temp directory whose path leaves no room for a socket path of at most 100 bytes turns the seat
  terminals off, and the boot log says why. `chatLocalPort` stays in the manifest only as the "attachable" marker.
- **Every `/chat` answer** may be framed only by this Studio: `content-security-policy: frame-ancestors 'self'`.
- **The WebSocket, when the principal carries `exp` or `sessions`** (a Studio behind server hooks): tunnelled the same way
  as the Desktop's. The `Origin` must be one of `SIGNIN_ORIGINS`; only the handshake headers reach ttyd; at `exp` the
  socket gets close code `4001`, and when its `sessions` end it, the session's code and reason. A principal with
  `sessions` but no `exp` is refused (`403`). Refusals carry a short reason in `x-openrig-chat`, and each close or refusal
  leaves one value-free boot-log line.
- **Otherwise** (the loopback default, or a hook whose principal carries neither): a plain tunnel, once the `Origin` is
  this Studio's own address (the admitted `Host`, over `http` or `https`) or an allowed origin (`STUDIO_ALLOWED_ORIGINS` on
  a loopback-only Studio, `SIGNIN_ORIGINS` behind hooks), so another site can't open a seat from the owner's browser.
  `Origin: null` is refused.
- **Before either:** the socket must be a socket owned by the Studio's user with no group or other access (the Studio
  tightens ttyd's own `0660` to `0600`), or the upgrade gets `503`.

## Off without admission: the Desktop

A box can offer its own desktop (VNC behind websockify on the same machine) as a WebSocket at `/desktop/ws`. The
Studio reads its settings **only when an admission hook is installed**; a loopback-only Studio never offers it.

- **The target:** `STUDIO_DESKTOP_SOCKET=/abs/path` (websockify on a Unix socket owned by the Studio's user, mode `0600`;
  preferred) or `STUDIO_DESKTOP_WS=ws://127.0.0.1:<port>[/path]` (loopback TCP). One fixed target: nothing in the request
  chooses it. An invalid value turns the Desktop off, and the boot log says why.
- **Who:** any admitted person who isn't files-only, whatever their `access` (the SDK doesn't narrow by role; admission
  decides who is admitted). `/api/studio/place` answers `desktop: "/desktop/ws"` only then, and
  only while the target is ready: a socket must exist, be owned by the Studio's user, and have no group or other access; a
  TCP target must accept a connection, found by one connect of at most 300 ms whose answer is kept for 2 s (a plain
  connect, not a WebSocket handshake). Otherwise `desktop` is `null`.
- **Origin:** the upgrade's `Origin` must be one of `SIGNIN_ORIGINS` (comma-separated), so another site can't open it with
  the person's cookie.
- **Expiry:** the principal must carry `exp` (seconds). Without it the upgrade is refused (`403`). At `exp` the socket gets a
  close frame, code `4001` `"sign-in expired"`, sent between two of the desktop's frames.
- **Session:** when the principal carries `sessions`, the tunnel calls `sessions.register(session, onClose)` once and runs the
  returned function when it ends. Calling `onClose({ code, reason })` closes it: a `403` with that reason before the
  upgrade completes, a close frame with that code (`4000`-`4999`) after. `sessions.check` is for admission to call.
- **What reaches websockify:** only the WebSocket handshake headers. No cookie, token or identity header.
- **Refusals** carry a short fixed reason in `x-openrig-desktop` and one boot-log line, never a token or an address.

## Off without admission: hosted terminals and the agents view

Without hooks, a Studio serves `/terminal/` and `/team/` itself, for this computer only (`tools/terminal.mjs`, see
`contract/app-manifest.md`). **With an admission hook installed**, the same sockets and two more go through
`tools/hosted-terminals.mjs` instead; the two never run together. Each route is a ttyd on its own Unix socket: its page is
proxied and its WebSocket tunnelled the same way as the Desktop's.

| Route | Socket | ttyd |
|---|---|---|
| `/terminal/`, `/terminal/ws` | `STUDIO_TERMINAL_SOCKET` | `-W -b /terminal` (`tools/start-terminal.mjs shell`) |
| `/team/`, `/team/ws` | `STUDIO_TEAM_SOCKET` | `-W -b /team` (`tools/start-terminal.mjs team`) |
| `/agents/watch/`, `/agents/watch/ws` | `STUDIO_AGENTS_WATCH_SOCKET` | `-a -b /agents/watch -- node tools/herdr-tile.mjs watch` (no `-W`: read-only) |
| `/agents/type/`, `/agents/type/ws` | `STUDIO_AGENTS_TYPE_SOCKET` | `-a -W -b /agents/type -- node tools/herdr-tile.mjs type` |

- **Who:** any admitted person who isn't files-only, whatever their `access`. A files-only guest gets `403` on the pages and
  the agents API, and its upgrades are refused. `/api/studio/place` answers `terminal`, `team` and `agents: { watch, type }` only
  then, each only while its socket is ready (a socket owned by the Studio's user, no group or other access); `terminals` gives
  each route's `state` and `reason`.
- **The socket:** one fixed path per route, absolute and at most 100 bytes. An invalid value turns that route off, and the boot
  log says why. A route that isn't set up answers `503` with `x-openrig-<word>: not ready`.
- **The page:** `GET`/`HEAD` only; an `Origin`, when sent, must be one of `SIGNIN_ORIGINS`; a cross-site request is refused; only
  content-negotiation headers reach ttyd; its `Set-Cookie` is dropped; it may be framed only by this Studio.
- **The WebSocket:** the `Origin` must be one of `SIGNIN_ORIGINS`; only the handshake headers go on, to the route's own `/ws`.
  The principal must carry `exp`: at `exp` the socket gets close code `4001`, and when its `sessions` end it, the session's code
  and reason (as for the Desktop).
- **The agents routes' arguments:** only `?arg=` values, in the exact shape `watch [qitem:<id>] <terminal id>` or
  `type [qitem:<id>] <terminal id> type|takeover`, optionally ending `--node <id> --conversation <sha256>`. Anything else gets
  `400` before ttyd. `tools/herdr-tile.mjs` checks them again, and checks that the terminal is one of this box's agent terminals.
- **`GET /api/agents/terminals`:** this box's agent terminals, read from Herdr through `STUDIO_HERDR_BIN` (an absolute path to
  an executable), fresh on each call. A read that fails is `503`, never an empty list. `STUDIO_RIG_NAME` adds each seat's
  session name. `?view=qitem:<id>` (the only parameter) reads one task's agents from the OpenRig daemon at
  `STUDIO_AGENTS_DAEMON` (`http://127.0.0.1:<port>`, loopback only), with the bearer from `STUDIO_AGENTS_DAEMON_TOKEN_FILE` (a
  file owned by the Studio's user, mode `0600`) when one is set. A terminal id is listed only for a viewer the daemon has verified.
- **`POST /api/agents/ensure`:** asks the daemon to ensure a task member's viewer. The `Origin` must be one of
  `SIGNIN_ORIGINS`; the body is JSON (`415` otherwise) of at most 4096 bytes (`413`), exactly
  `{ view, member: { hostId, nodeId }, expectedPlan }` (`400 body_invalid` otherwise). The daemon's answer comes back as it gave
  it. Nothing here calls the daemon's open.
- **Audit:** one log line per terminal opened, closed or refused, and per ensure: the principal's `email`, the time and why.
  Never what was typed or shown, a token or an address.

## Always on: the child key

Whatever the admission, the runtime and every provider answer only this Studio.
- **How:** each boot makes a new random key. Each Node child is started with `tools/child-key.mjs` preloaded, and gets the key in
  its environment, never its arguments.
- **What a child does:** it refuses (`403`) any request or upgrade without the key, so a DNS-rebound page or a stray local tool
  can't reach it on its own port and go around the Studio's gate. It doesn't separate the accounts on one computer: the
  Studio's own port answers all of them (see "Who a local Studio trusts").
- **The key is stripped** before the child's own code sees the request.
- **The marker:** `Symbol.for("openrig.studio.childKey")` on `globalThis` tells a provider that every request it gets came
  through the Studio. A provider trusts headers that admission wrote only when the marker is present.

## Off without admission: project apps

A generated app can be served on an **origin of its own** by `tools/project-app-server.mjs`: its static files under
`/project-apps/<app>/`, and nothing else. It is a separate process from the Studio, on `127.0.0.1`, behind whatever puts the
app's public name in front of it. It runs **only with admission for project apps**; there is no loopback default.

```sh
node tools/project-app-server.mjs --hooks /abs/hooks.mjs --app <id> --root /abs/app/folder \
  --origin https://app.example [--studio-origin https://studio.example] [--auth-binding /abs/binding.json] [--port 8893]
```

- **The seam:** the hooks module's named export `projectApp(ctx)` (it may be async). It is separate from `install(ctx)`,
  because the app's origin needs a sign-in bound to that origin, not the Studio's. `ctx` is `{ app, origin, studioOrigin,
  binding, log }`: `binding` is the parsed `--auth-binding` file (or `null`), passed as is. **No environment and no Studio
  route:** what this listener admits is configured on purpose, never borrowed from the Studio. It returns
  `{ describe?, admission: { http, upgrade }, close? }`, the same admission shape as `install`.
- **Off:** no `--hooks`, a module that can't load, no `projectApp` export, a malformed answer, or a loopback admission: it
  doesn't start (exit 1). The process reads no setting from its environment; every input is a flag.
- **Started through a link:** the command line runs however the file is reached, a symlinked path included (it compares
  real paths).
- **Admission decides every request and upgrade.** It answers a refusal itself. Whoever it admits (with a principal object)
  gets the app's files: the SDK doesn't narrow project apps by `access` or `workspace`. An admitted upgrade still gets
  `404`: there is no WebSocket here.
- **Before admission:** a `Host` other than the origin's gets `421`.
- **The files:** `GET`/`HEAD` only (`405` otherwise); `/` and `/project-apps/<app>` redirect (`308`) to
  `/project-apps/<app>/`; any other path is `404`. Each file is resolved with `realpath` and must stay inside `--root`, so
  a symlink or an encoded `..` is `404`. Served `no-store`, `nosniff`, read live.
- **The way back:** with `--studio-origin`, an admitted `GET /_openrig/auth-return?studio=<url>` answers `303` to that
  URL, only when it is the Studio origin's `/` with `s=<app>` and `studio` is the only parameter (`400` otherwise). It
  lets the app origin's own sign-in finish at the top level, then return to the Studio.
- **In the shell:** a `url` surface on the app's origin is shown in a frame, but the shell neither hears it nor sends it
  messages (`shell-protocol.md`), so the app can't act as the person on the Studio.

## Checked by

`test/no-rig.test.mjs`: with `"rig": false` the `rig` command is never run, and a declared roster still applies.

`test/server-hooks.test.mjs`:
- the loopback default refuses a foreign `Host` for requests and upgrades;
- the Origin rule, case by case, and on a real Studio: a cross-site change to a provider verb or to the runtime is refused, and
  the same change from the Studio's own page, an allowed origin or a local tool works; an upgrade from another site or from
  `Origin: null` is refused;
- the shell page's frame rule;
- a malformed request URL gets `400` (a request and an upgrade) and the Studio keeps serving; an admission that throws or
  rejects gets `503`, and one that admits without a principal `403`;
- `/healthz` is never gated, and gives its children only to a loopback or allowed `Host` on a loopback Studio, or behind hooks when the box sets `STUDIO_HEALTH_DETAIL=1`;
- a hook's admission decides, and the headers it writes reach providers;
- the shell, place (a `null` label included), health and child seams;
- a hook that can't load stops the boot.

`test/shell-hook-pieces.test.mjs`: the shell's `#rail-private` slot, its sign-in renewal and the chat panel's import and
meta.

`test/public-terminal.test.mjs`: the local terminals' frame rule, `Origin: null` refused, and their allowed origins read from
`STUDIO_ALLOWED_ORIGINS` (not `SIGNIN_ORIGINS`).

`test/seat-terminal.test.mjs`: the seat socket's folder and mode, no TCP listener, the frame rule, the loopback Origin rule,
and, behind hooks, closing at `exp` and when the session ends.

`test/desktop.test.mjs`: the Desktop is off without hooks; with a hook, Origin, files-only, expiry and session closing, and
place following readiness for a socket and a TCP target.

`test/hosted-terminals.test.mjs`: the hosted routes and the agents API are off without hooks (the local terminal still serves);
with a hook, the page and WebSocket checks, files-only, expiry, session closing, readiness, the agents routes' arguments, the
Herdr list, task views and ensure. `test/herdr-tile.test.mjs` and `test/original-terminal.test.mjs`: the agents wrapper.

`test/project-app-server.test.mjs`: project apps are off without admission (the function, the loader and the command line);
with a hook, admitted and refused requests and upgrades, the `Host` check, no Studio route, the way back, the command line
through a symlinked path, and the shell's origin guard. `test/project-app-assets.test.mjs`: the files, `HEAD`, live edits and containment.
