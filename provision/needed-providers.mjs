#!/usr/bin/env node
// Which provider directories does THIS set of apps actually need?
//
//   node needed-providers.mjs <appsRoot> <app> [app...]     -> one directory name per line
//
// WHY THIS EXISTS: provisioning installed dependencies for every provider on
// disk regardless of which apps were enabled, so a provider nobody asked for
// could stop the whole install. A box asking for four apps should not be
// stopped by the eleventh provider. Found by cloud-impl on a real VPS, where
// exactly that happened.
//
// WHY IT IS NODE AND NOT SHELL: this walks JSON and emits a set. Structured data
// does not round-trip through the shell's word list, and the caller reads the
// output line by line rather than splitting it.
//
// TWO WAYS AN APP NEEDS A PROVIDER, and only the first is obvious:
//   1. it NAMES one — `provider.package`
//   2. it REQUIRES A VERB somebody else serves — `calls` with `required: true`.
//      `calls` is provider-agnostic by design (app-manifest.md), so the box works
//      out who answers. An app whose required call is unserved is refused at
//      reconciliation, and a provider whose deps were never installed cannot
//      start to serve it.
// Optional calls deliberately pull nothing in: `required: false` grants no
// authority to start a provider, so it grants none to install one either.

import fs from "node:fs";
import path from "node:path";

const [appsRoot, ...apps] = process.argv.slice(2);
if (!appsRoot || !apps.length) {
  console.error("usage: needed-providers.mjs <appsRoot> <app> [app...]");
  process.exit(2);
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};
const dirOf = (pkg) => (typeof pkg === "string" && pkg ? path.basename(pkg) : null);

const providersDir = path.join(appsRoot, "providers");
const onDisk = fs.existsSync(providersDir)
  ? fs.readdirSync(providersDir).filter((d) => fs.statSync(path.join(providersDir, d)).isDirectory())
  : [];

// verb -> provider directory, read from each provider's own declaration. The
// provider is authoritative about which verbs it answers; nothing else can say.
const answers = new Map();
for (const d of onDisk) {
  const decl = readJson(path.join(providersDir, d, "provider.json"));
  for (const v of decl?.verbs ?? []) if (!answers.has(v)) answers.set(v, d);
}

const needed = new Set();
for (const app of apps) {
  const m = readJson(path.join(appsRoot, "apps", app, "app.json"));
  if (!m) continue;

  const direct = dirOf(m.provider?.package);
  if (direct) needed.add(direct);

  for (const [verb, spec] of Object.entries(m.calls ?? {})) {
    if (!spec?.required) continue;
    // A verb ending in `/` is a prefix match (app-manifest.md), so an exact
    // lookup alone would miss `/api/export-status/<id>`-shaped declarations.
    const who = answers.get(verb)
      ?? [...answers.entries()].find(([v]) => v.endsWith("/") && verb.startsWith(v))?.[1];
    if (who) needed.add(who);
  }
}

// Only ones that exist. A named-but-absent provider is reconciliation's problem
// to report, not this script's to invent.
for (const d of [...needed].sort()) if (onDisk.includes(d)) console.log(d);
