#!/usr/bin/env node
// Workspace-scoped release files, not a host/provider control plane.
import fs from "node:fs";
import {
  inspectWorkspace,
  planRelease,
  applyRelease,
  activateRelease,
  rollbackWorkspace,
} from "../lib/releases/workspace.mjs";

const HELP = `Studio release files: inspect | plan | create | apply | activate | rollback

  node tools/studio-release.mjs inspect --workspace <Studio directory>
  node tools/studio-release.mjs plan --workspace <dir> --release <descriptor.json> [--core-version <v>]
  node tools/studio-release.mjs create --workspace <dir> --release <descriptor.json> [--config <studio.json>]
  node tools/studio-release.mjs apply --workspace <dir> --release <descriptor.json> [--keep-local]
  node tools/studio-release.mjs activate --workspace <dir> [--host-receipt <receipt.json>]
  node tools/studio-release.mjs rollback --workspace <dir>

Unversioned adoption also needs --baseline <known release.json>, --adopt-sdk <root>
and --adopt-apps <root>, with adoptUnversioned:true. Original roots are retained.
Plan and inspect are inert. Results are JSON and include an explanation/next step.
A component's runtime need (runtime.openrigCore) is reported by plan against
--core-version, the host runtime's version; it never refuses the plan.
Keep customer apps/providers in extensions/apps|providers with their manifests.
Applying the installed release again relinks a changed extension set (plan: relink,
extensionChanges); tools/install-app.mjs does that for one app. inspect shows
extensions.mounted/pending and the runtime's reported activation for the marker.
--keep-local explicitly retains reported vendor edits and extension replacements.
Code switches are checkpointed; rollback does not restore config or data. This
command never starts services or agents and never runs host operations/migrations.
Host dependencies/migrations stage files and yield partial without changing the
current pointer. Activate accepts their matching workspace-scoped receipt.
Interrupted activation keeps pending.json; inspect then activate reconciles it.
An interrupted operation needs inspect/checkpoint reconciliation before retrying.
`;
try {
  const [verb, ...args] = process.argv.slice(2);
  if (!verb || ["--help", "-h", "help"].includes(verb)) {
    process.stdout.write(HELP);
  } else {
    const options = {};
    const names = {
      "--workspace": "workspace",
      "--release": "release",
      "--core-version": "coreVersion",
      "--baseline": "baseline",
      "--adopt-sdk": "adoptSdk",
      "--adopt-apps": "adoptApps",
      "--config": "configFile",
      "--host-receipt": "hostReceiptFile",
    };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--keep-local") {
        options.keepLocal = true;
        continue;
      }
      const key = names[args[i]];
      if (!key || !args[i + 1] || Object.hasOwn(options, key))
        throw Error("Unknown, duplicate or missing argument. Use --help.");
      options[key] = args[++i];
    }
    if (!options.workspace)
      throw Error("--workspace is required; no default host/workspace is selected.");
    if (options.hostReceiptFile)
      options.hostReceipt = JSON.parse(fs.readFileSync(options.hostReceiptFile, "utf8"));
    let result;
    if (verb === "inspect") {
      const { installed, ...observed } = inspectWorkspace(options.workspace);
      result = observed;
    } else if (verb === "rollback") result = rollbackWorkspace(options.workspace);
    else if (verb === "activate") result = activateRelease(options);
    else if (["plan", "create", "apply"].includes(verb)) {
      if (!options.release) throw Error("--release is required.");
      if (options.configFile)
        options.config = JSON.parse(fs.readFileSync(options.configFile, "utf8"));
      if (verb === "create" && inspectWorkspace(options.workspace).release)
        throw Error("Workspace already has a release; inspect/plan/apply it instead.");
      result = verb === "plan" ? planRelease(options).plan : applyRelease(options);
    } else throw Error("Unknown command. Use --help.");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.outcome === "refused" || result.supported === false || result.outcome === "unknown")
      process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      outcome: "unknown",
      reason: error.message,
      next: "Read the workspace checkpoint/current pointer before retrying; use --help for supported operations.",
    }) + "\n",
  );
  process.exitCode = 1;
}
