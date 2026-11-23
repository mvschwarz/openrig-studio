# Contributing to Studio

Start with README.md and the relevant contract under contract/. Customer apps
can use the normal manifests and extension directories without patching shipped
files. Keep a change scoped and add a focused runnable check for its behavior.

You need Node 22 or later and Python 3 (`python3`; the release tools and their
tests use it). Use `npm ci` for the committed dependency lock.

`npm run check` runs everything CI runs: ESLint, the Prettier format check, the
comment check and the test suite. `npm run format` applies the formatting.
Release-tool checks alone run with
`node --test test/releases.test.mjs test/release-settings.test.mjs`.

Comments say why the code is the way it is. Who asked for a change, who
reviewed it, ticket ids and dates belong in commit messages, not in source;
`npm run check:comments` refuses them.

Keep existing licenses/notices, including bundled dependency notices. Examples
should work with public inputs in an isolated workspace. Don't put credentials,
customer data or private operating context in source, examples or packages.
Package/version changes follow the repository's existing maintainer/release
path; a local artifact is not a publication.
