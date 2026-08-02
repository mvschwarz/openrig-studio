# @openrig/create-studio

The create-app on-ramp: scaffold a working openrig studio surface, wired to
contract v0.1, in one command.

## Status of the public command

The intended front door is:

```sh
npm create @openrig/studio my-surface
```

npm resolves that to the package **`@openrig/create-studio`** and runs its bin.

**That command does not work yet.** This package is unpublished and its final
name is a deferred decision, so there is nothing on the registry to resolve.
Publishing is a metadata step — flip `private`, settle the name, publish — and
changes nothing about the code below.

## Running it today

Directly, from the repository root:

```sh
node create-studio/index.mjs my-surface
```

Or through the real npm resolution path, against a local pack — same bin, same
entrypoint, no registry:

```sh
npm pack ./create-studio
npm exec --package=./openrig-create-studio-0.1.0.tgz -- create-studio my-surface
```

## Options

```
create-studio <name> [--dir <parent>] [--glyph <char>] [--hint <text>]
```

| Option | Meaning |
|---|---|
| `<name>` | Project directory and surface id. Lowercase letters, digits and dashes. |
| `--dir` | Where to create the project (default: current directory). |
| `--glyph` | One-character rail glyph (default `◆`). |
| `--hint` | One-line rail tooltip. |

## What it emits

```
my-surface/
  surface.html        the surface — one self-contained page, no build step
  surfaces.row.json   the schema-valid manifest row that registers it
  README.md           how to install it, and where the contract docs are
```

The emitted surface uses **only stable-classified** contract items: the
`/api/contract` boot check, `/api/factory/state`, the `/api/events` change
signal (refresh-only, with the documented degraded/polling fallback), and the
`open-agent` shell message. Nothing marked *provisional* or *runtime-internal*
is generated.

## How it refuses

Every check runs **before** anything is written, so a rejected run leaves the
filesystem untouched:

- names must be a single path segment — no traversal, no absolute paths, no `~`
- no leading dots, no reserved names, 64 characters max
- lowercase letters, digits and dashes only
- an existing **non-empty** destination is refused

Generation stages into a sibling temp directory and lands with one atomic
rename, so an interrupted run cannot leave a half-written project that looks
usable.

`OPENRIG_STUDIO_CREATE_FAIL_AFTER=<n>` forces a failure after `n` files have
been staged. It exists so the no-partial-output guarantee can be demonstrated
rather than asserted; it is inert when unset.

## Option values are escaped per output context

`--hint` takes arbitrary text and `--glyph` takes any single character, so both
can carry quotes, backslashes, newlines or markup. Each output context handles
them differently and the generator treats them separately:

- **JSON** — the manifest row is built as an object and serialized. It is never
  string-substituted into a JSON literal, because that is what previously let a
  quoted hint emit a file `JSON.parse` rejects while the CLI reported success.
- **HTML** — every interpolated value is escaped, so a hint containing markup
  renders as text rather than becoming an element.
- **JS** — the one value crossing into a `<script>` is JSON-encoded, not
  HTML-escaped; escaping there would put a literal `&quot;` into code.
- **Markdown** — deliberately not escaped, because escaping inside a code span
  is wrong. Safety rests on the project-name rules, and the generator asserts
  that invariant rather than assuming it.

## Tests

```sh
npm test          # from the repo root, or from create-studio/
```

Zero dependencies — `node:test` only. The suite covers generation, every
admission boundary, no-partial-output on forced failure, schema shape and
stability class of the emitted row, the hostile-value matrix for every
user-controlled field, and the packed-tarball bin path.
