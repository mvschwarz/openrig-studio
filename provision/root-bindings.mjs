#!/usr/bin/env node
// Resolve root-KIND bindings from the app manifests and emit them as JSON.
//
// This is a module rather than a `node -e` string inside the provisioner because
// the defect it fixes could not be tested from in there, and the house rule is
// that a fix of this class ships with a control that would have caught it.
//
// THE DEFECT (measured by review-r1, not hypothesised). The provisioner used to
// collect kinds into a space-separated string and then loop over it UNQUOTED, so
// the shell word-split AND pathname-globbed names that came out of somebody
// else's manifest:
//
//   "footage archive"  ->  bound "footage" and "archive"; never the declared kind
//   "zzz*"             ->  bound whatever filenames matched in the provisioner's CWD
//
// Both write VALID JSON, so the validator that runs immediately after cannot see
// either one. The studio is then mis-rooted at runtime and the install reports
// success — and in the glob case the result depends on which directory the
// operator happened to be standing in.
//
// THE FIX IS NOT TO QUOTE HARDER. It is to stop round-tripping structured data
// through the shell's word list at all: kinds are read here, bound here, and
// serialized here. That is the rule create-studio already follows for its
// manifest row — build the object and serialize it, never template the text —
// and it removes the class instead of escaping one instance of it.

import fs from "node:fs";
import path from "node:path";

// The conventional homes. A kind that is not one of these is NOT an error: the
// vocabulary is open by design (contract/app-manifest.md). It gets a directory
// named after itself and is REPORTED, so a generated default is never mistaken
// for a considered decision about what that root means.
export const conventional = (media) => ({
  media,
  footage: path.join(media, "footage"),
  project: path.join(media, "projects"),
  canvas: path.join(media, "canvases"),
});

export function rootBindings({ appsDir, media, apps }) {
  const kinds = new Set();
  for (const a of apps) {
    const f = path.join(appsDir, a, "app.json");
    if (!fs.existsSync(f)) continue;
    const roots = JSON.parse(fs.readFileSync(f, "utf8")).roots || {};
    for (const k of Object.keys(roots)) kinds.add(k);
  }

  const known = conventional(media);
  // Object.create(null), and Object.hasOwn rather than `in`, because these keys
  // come from a manifest this box did not write. On a plain object a kind named
  // "__proto__" assigns nothing and vanishes from the output silently, and `in`
  // reports "constructor" as a known kind and binds it to a FUNCTION, which
  // JSON.stringify then drops — the same shape as the bug above (a declared
  // kind disappearing while the file stays valid), reached through the
  // prototype chain instead of through the shell.
  const bindings = Object.create(null);
  const generated = [];
  for (const kind of [...kinds].sort()) {
    const dir = Object.hasOwn(known, kind) ? known[kind] : path.join(media, kind);
    if (!Object.hasOwn(known, kind)) generated.push({ kind, dir });
    bindings[kind] = dir;
  }
  return { bindings, generated, kinds: [...kinds].sort() };
}

// CLI: bindings as JSON on stdout, human notices on stderr, directories made.
// Split that way so the caller can capture the JSON with a plain command
// substitution while the operator still sees what was decided.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [appsDir, media, ...apps] = process.argv.slice(2);
  const { bindings, generated, kinds } = rootBindings({ appsDir, media, apps });
  process.stderr.write(`  root kinds declared by these apps: ${kinds.join(" ") || "<none>"}\n`);
  for (const { kind, dir } of generated) {
    process.stderr.write(`  generated default binding for new root kind "${kind}" -> ${dir}\n`);
  }
  for (const dir of Object.values(bindings)) fs.mkdirSync(dir, { recursive: true });
  process.stdout.write(JSON.stringify(bindings));
}
