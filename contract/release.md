# Workspace release contract v0

The SDK owns `openrig.release/v0`. A release's publisher supplies concrete immutable
descriptors; the host's operator supplies workspace bindings and host operations.
This interface does not give a tenant access to fleet credentials or arbitrary host
commands.

```json
{
  "schema": "openrig.release/v0",
  "release": "<product-release-id>",
  "line": "pre-1.0",
  "compatibility": { "policy": "Explicit upgrade edges before 1.0", "upgradeFrom": [], "adoptUnversioned": true },
  "components": {
    "studioSdk": {
      "name": "@openrig/studio", "version": "<sdk-version>",
      "artifact": { "file": "sdk.tar.gz", "sha256": "<64 hex>", "bytes": 123 },
      "source": { "repo": "openrig-studio", "rev": "<git revision>" },
      "interfaces": { "studioContract": "v0.1", "sampleApi": "v2" },
      "vendorBaseline": { "file": "sdk.sha256", "sha256": "<64 hex>" }
    },
    "studioApps": {
      "name": "@openrig/studio-apps", "version": "<apps-version>",
      "artifact": { "file": "apps.tar.gz", "sha256": "<64 hex>", "bytes": 123 },
      "source": { "repo": "openrig-studio-apps", "rev": "<git revision>" },
      "requires": { "studioSdk": "<supported-sdk-range>", "studioContract": "v0.1", "sampleApi": "v2" },
      "vendorBaseline": { "file": "apps.sha256", "sha256": "<64 hex>" }
    }
  },
  "customerOwned": ["studio.json", "extensions", "project", "data"],
  "migrations": []
}
```

Components have separate SemVer lifecycles. A component requirement is a SemVer
range; another requirement names an exactly advertised interface. **Build metadata
does not constrain compatibility.** build metadata such as `+variant.1` does not distinguish an otherwise equal semantic version,
but does not itself advertise `sampleApi: v2`. Artifacts and patch stacks remain digest-locked.
Ranges use normal node-semver rules (no includePrerelease override); a prerelease
must be named by an explicit prerelease comparator, as in the example.
The Apps baseline uses the existing `MANIFEST.sha256`: `sha256`, two spaces, then
the relative regular-file path. A baseline contains every payload file, once.
Artifacts contain regular files/directories only; path escapes and links are not
an extraction/installation mechanism. File names are relative to the descriptor.

The generic local executor handles `studioSdk` and `studioApps`. Other components
(such as OpenRig Core or a host recipe) stay exact locked host operations; they
are not executed through tenant shell access. An output cannot claim a complete
product release until all named host steps have matching successful receipts.
An SDK/Apps-only fixture demonstrates those components, not a complete product.

A component may state what it needs from the host runtime with `runtime`, for example
`"runtime": { "openrigCore": ">=0.7" }` (each value a semver range, same rules as
above). It is reported, never enforced, because the runtime is a host operation:
`plan --core-version <v>` adds `runtime: [{component, runtime, needs, observed, met}]`
with `met` true, false, or `"unknown"` when no version (or no valid version) was
given, and an explanation sentence for each need that isn't met. `supported` and
`apply` don't depend on it. A descriptor that ships the runtime as a component can
still state a hard requirement with `requires`.

A descriptor may give `initialConfig`, the settings a new workspace's `studio.json`
starts with, for example `"initialConfig": { "serverHooks": ".studio-release/current/studioSdk/hooks.mjs", "rig": false }`.
It must be an object; it can't set `appsRoot` (the executor writes that), and a
`serverHooks` value must be a path relative to the studio folder. It's used only when
`apply` creates a workspace that has no `studio.json`, under the creator's own
`--config` (the creator's value wins, key by key). Adoption and upgrades never apply
it, because `studio.json` belongs to the customer: `inspect` reports each key that
differs as `configDrift: [{key, expected, actual}]` instead (empty when none differ).

Host dependencies stage without switching current code. The operator supplies
`openrig.host-release-receipt/v0` with `{release, descriptorSha256, components:
{id: {version, sha256, outcome: "done"}}, migrations: [{id, outcome: "done"}]}`.
An operator adapter binds that input to its own workspace authority; the generic
file installer neither gains that authority nor executes arbitrary host commands.
`activate` reconciles the checkpoint and switches code only after these checks.

The workspace's `studio.json`, customer extensions, projects, provider homes and
Core data remain outside replaceable vendor generations. Navigation/app ordering
uses `studio.json.apps`. Added apps/providers use their existing manifests under
`extensions/apps` and `extensions/providers`. Apps keep their manifest id;
providers use existing package/directory resolution and need no new `id` field
in provider.json. Own surface styles are supported; the current fixed shell tokens have no general theme hook. Editing shipped shell
or app implementations is explicit vendor drift, retained for reconciliation.
Vendor prompts, skills and bootstrap instructions use the same file baseline as
code and assets. Customer prompts/worlds keep their owned homes. A package must
not gather the packager's private local startup or operating context.

**Adding, updating or removing your own app after install.** Put it in
`extensions/apps/<id>` (and its own provider in `extensions/providers/<dir>`),
or let `tools/install-app.mjs <app> [--provider <dir>] --enable` do that on a
managed workspace: it validates the app as usual, writes only `extensions/`,
links it, and enables it in `studio.json`. It never writes into a generation.
Applying the INSTALLED release again relinks a changed extension set: the plan
reports `relink: true` and `extensionChanges {added, removed, relinked}`, and
apply builds a new generation that copies the current one exactly (vendor edits,
deletions and modes included) with only the links changed, keeping the previous
generation for rollback. An unchanged set is a noop that writes nothing. An
extension that shadows a shipped app/provider still needs `--keep-local`. When an
extension that replaced a shipped app/provider is removed, the relink restores the
shipped one, re-extracted from the installed release's own verified artifact, so it
needs that release's descriptor (`apply --release <the installed descriptor>`); the
plan says which come back, and `extensions.json`'s `last` lists them as `restored`.
Files inside an already-linked extension change in place and need no relink; the
installer's `--force` update does that. The installer refuses a provider whose
relative imports leave its own folder (only that folder is installed), naming the
import; `--allow-outside-imports` installs anyway when the reading is wrong. The check reads the JavaScript files the entry reaches
(`.mjs`, `.cjs`, `.js`) for relative and `file:` specifiers in `import`, `export … from`, `import()` and `require()`; it says so when an
entry it can't read (a `.ts` or `.mts`) isn't checked. It's a guard against a provider that can't start once installed, not a boundary:
`#imports` from a `package.json` that isn't copied, `new URL(…, import.meta.url)`, `import.meta.resolve` and a `createRequire` built at
run time aren't followed. `inspect` reports `extensions.mounted`
and `extensions.pending` (what a relink would change).

**The registration signal.** After every successful registration change (add,
in-place update, removal, relink, upgrade, rollback) the library writes
`.studio-release/extensions.json` atomically:
`{schema: "openrig.extensions-state/v0", marker, at, generation, mounted: [{path, source, contentSha256}], last: {kind, ...}}`.
`marker` is opaque and changes on every write; a failed operation leaves the
previous record. This records REGISTRATION, not activation. A runtime that
activates extensions reports its own outcome in `.runtime/extensions-status.json`
(`{schema: "openrig.extensions-activation/v0", marker, generation, state: "active" | "failed", at, pid, error?, missing?}`;
`missing` lists enabled apps that were left out because they couldn't be composed).
`inspect` shows it as `extensions.activation` only when marker and generation
match the current record (otherwise `not-reported`), and always with
`liveHealth: "not-checked"`: a past report is not a statement about the running
process. The SDK's launcher (`tools/studio.mjs`) is such a runtime: it activates
each new marker live and reports it (manifest.md, "Live activation"). Until a
runtime reports, a registered app is not active: restart the Studio and verify
by effect.

An agent first inspects and plans. The plan reports installed/desired versions,
artifact and interface checks, drift, extensions, migrations, restarts, and the
recovery path. Applying with local drift needs an explicit decision to keep it;
it is never silently overwritten. Original generations/checkpoints remain.
Configuration and data are not reset during a code rollback. This first executor
does not run data migrations: a nonempty applicable migration list is a named
host dependency, not an invented successful operation.

Permission-only drift is reported as `mode-only`, with the old baseline's
`expectedMode` and the installed file's `mode`. With `--keep-local`, the incoming
file's NEW bytes remain and its local mode is retained, including executable
bits. If the incoming release removes or changes that regular-file path, no old
file is copied back just to retain its permissions. Real content edits and
deliberate deletions retain their existing preservation behavior. A packaging
permission envelope or normalized archive mode is not an observation of installed
permissions; baseline provenance must say which it represents.

Before 1.0, patches preserve interfaces and minors may require migration.
Only declared `upgradeFrom` edges are supported. An older unversioned workspace
can enter through `adoptUnversioned` with its known vendor baseline and actual
SDK/Apps roots; the tool reports local differences and retains the old roots.
The shared creation and upgrade tool consumes the same artifacts. No publication
or real customer upgrade is authorized merely by authoring a descriptor.

Planning and application refuse known SDK/Apps version downgrades, including
adoption against its declared baseline. Use the explicit rollback command for a
code rollback. Deliberate vendor-file deletions remain local changes, even if an
intervening release omits that path. Startup does not restore deleted apps or
configuration. A removed required `studio.json` is an explicit reconciliation
conflict; its original creation inputs stay in the retained receipt.

A public SDK user needs only a public SDK component and their own manifested app.
Managed host components, provider credentials and hosted services are not
required by this generic schema or its create/upgrade interface. Product-specific
requirements and composed profiles belong in their own release descriptors.

## Commands and state

`node tools/studio-release.mjs --help` names the arguments. `inspect` and `plan`
are inert. `create` and `apply` share the installer. `--keep-local` retains vendor
drift explicitly. Legacy adoption names the known descriptor with `--baseline`
and the actual `--adopt-sdk`/`--adopt-apps` roots; those roots are never deleted.
`activate` reconciles interrupted/staged activation, optionally with
`--host-receipt`. `rollback` switches code to its retained generation; it does
not claim to restore database or project data.

Under the chosen Studio directory, `.studio-release/installed.json` follows the
current generation's receipt; `.studio-release/pending.json` is its staged
checkpoint. `.studio-release/releases/` retains code generations. The operation
lock has an owner PID; inspect an interrupted owner's process before removing
a stale lock. Configuration adoption and ordinary app enabling share the stable
`studio.json.lock` inode and merge only their own field. Other settings writers
must cooperate with that lock; never unlink/replace it. Receipts distinguish
file installation from runtime readiness (`runtimeVerified` remains false).
Node 22 or later and POSIX Python 3 are needed; no hosted service is required.

Inspect and completed results also report `effective`: installed component source
revisions, unknown active revisions, and the existing service reload/restart and
instruction reload/handover steps. The SDK owner stamp records a PID and port,
not an exact loaded source or agent-context revision. File installation therefore
cannot claim those revisions became effective. Keep original conversations and
use the existing operator/agent reconciliation path; no acknowledgement service
or automatic conversation restart is introduced.

## Component inventory and notices

| Component | Source/distribution | Existing license | Maintenance |
|---|---|---|---|
| SDK and release tools | Public source/package | Apache-2.0; LICENSE/NOTICE retained | Studio maintainers and existing release path |
| semver7.7.4 | Public npm; locked/bundled dependency | ISC; its LICENSE included | Upstream node-semver, pinned in package-lock.json |
| Node/Python | External prerequisites, not bundled | Their distributions' terms | Runtime provider/user |
| Customer apps/prompts/worlds | Customer-owned extension/data roots | Their owners' terms | Customer and their coding agents |

The SDK supplies app/composition primitives and small release tools, not a new
agent framework. A product may compose other independently maintained components;
their visibility and policies do not become mandatory public SDK dependencies.
