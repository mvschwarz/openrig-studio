// Regression suite for the composer — the first tests tools/ has ever had.
//
//   node --test 'test/*.test.mjs'
//
// tools/ is the highest-risk code in this repo: it spawns processes, proxies
// traffic and guards ports, and it had zero coverage while the runtime had
// eighty tests. This covers the composition rules that decide WHAT gets started,
// because those are the ones whose failure looks like a working studio.
//
// Every case below is a rule from contract/app-manifest.md. If a rule changes,
// this file should fail before anyone finds out from a box.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeRail, verbMatches } from "../tools/compose-rail.mjs";

// A throwaway apps tree: apps/<id>/app.json + providers/<name>/provider.json,
// exactly the layout the composer reads on a real box.
function tree({ apps = {}, providers = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-"));
  const studio = path.join(root, "studio");
  fs.mkdirSync(studio, { recursive: true });
  for (const [id, manifest] of Object.entries(apps)) {
    const dir = path.join(root, "apps", "apps", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify({
      manifest_version: 1, id, name: id.toUpperCase(),
      surface: { entry: "page.html", path: `/surfaces/${id}.html`, glyph: "◆" },
      ...manifest,
    }, null, 2));
    fs.writeFileSync(path.join(dir, "page.html"), `<html>${id}</html>`);
  }
  for (const [name, decl] of Object.entries(providers)) {
    const dir = path.join(root, "apps", "providers", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "provider.json"), JSON.stringify(decl, null, 2));
  }
  return {
    run: (enabled) => composeRail({
      appsRoot: path.join(root, "apps"),
      enabled,
      runtimeDir: path.join(studio, ".runtime"),
      studioRoot: studio,
    }),
  };
}

// ------------------------------------------------- the provider owns itself

test("a provider.json run spec WINS over an app-declared one, naming both", () => {
  // The converge rule. Two authorities for one process is what this removes, so
  // the moment a provider declares, the app's copy stops being consulted.
  const t = tree({
    apps: { alpha: { provider: { package: "@x/host", run: { entry: "STALE.mjs" } } } },
    providers: { host: { package: "@x/host", run: { entry: "real.mjs" }, verbs: ["/api/a"] } },
  });
  const r = t.run(["alpha"]);

  assert.equal(r.providerRuns.get("@x/host").run.entry, "real.mjs",
    "the app's stale run spec was used even though the provider declared its own");
  assert.ok(r.warnings.some((w) => /run spec declared BOTH/.test(w) && /alpha/.test(w)),
    "the ignored app copy must be named, not silently dropped");
});

test("without a provider.json the app-declared spec is honoured, and says it is legacy", () => {
  const t = tree({
    apps: { alpha: { provider: { package: "@x/host", run: { entry: "legacy.mjs" } }, verbs: ["/api/a"] } },
  });
  const r = t.run(["alpha"]);

  assert.equal(r.providerRuns.get("@x/host").run.entry, "legacy.mjs", "the transition must not break today's apps");
  assert.ok(r.warnings.some((w) => /LEGACY/.test(w)), "the legacy path must announce itself");
});

test("a provider's companions travel with the provider, not with whoever uses it", () => {
  // The bug this format change exists for: the state generator was declared in
  // one app, so retiring that app deleted a capability every surface used.
  const t = tree({
    apps: { alpha: { provider: { package: "@x/host" } }, beta: { provider: { package: "@x/host" } } },
    providers: { host: { package: "@x/host", run: { entry: "s.mjs", companions: [{ label: "gen", entry: "live.mjs" }] } } },
  });

  const withBoth = t.run(["alpha", "beta"]);
  const withoutAlpha = t.run(["beta"]);

  const companions = (r) => r.providerRuns.get("@x/host").run.companions.map((c) => c.entry);
  assert.deepEqual(companions(withBoth), ["live.mjs"]);
  assert.deepEqual(companions(withoutAlpha), ["live.mjs"],
    "removing an app deleted a companion the PROVIDER declared — the exact defect this change removes");
});

test("EVERY contract field on a provider.json reaches the spec, not just the ones in use", () => {
  // This existed and was broken: the composer copied run/serves/verbs and
  // dropped `seeds` and `supplies`, so a field the contract documents could not
  // reach the code that reads it. The reader in studio.mjs was permissive
  // enough to accept two shapes, which hid the broken writer rather than
  // exposing it — a declaration simply did nothing, silently, for every
  // provider except the one the legacy fallback happened to name.
  //
  // Asserted field by field so that ADDING a field to the contract without
  // carrying it here fails in this test, rather than on someone's box.
  const t = tree({
    apps: { alpha: { provider: { package: "@x/video" } } },
    providers: {
      video: {
        package: "@x/video",
        run: { entry: "v.mjs", companions: [{ label: "lane", entry: "w.mjs" }] },
        serves: ["/media/"],
        verbs: ["/api/clips"],
        supplies: ["ffmpeg", "ffprobe"],
        seeds: { root: "project", marker: "timeline.json", entry: "new.mjs", export: "scaffold" },
      },
    },
  });
  const spec = t.run(["alpha"]).providerRuns.get("@x/video");

  assert.equal(spec.run.entry, "v.mjs");
  assert.deepEqual(spec.run.companions.map((c) => c.entry), ["w.mjs"]);
  assert.deepEqual(spec.serves, ["/media/"]);
  assert.deepEqual(spec.verbs, ["/api/clips"]);
  assert.deepEqual(spec.supplies, ["ffmpeg", "ffprobe"], "supplies was dropped — the install gate reads it");
  assert.deepEqual(spec.seeds, { root: "project", marker: "timeline.json", entry: "new.mjs", export: "scaffold" },
    "seeds was dropped, so a documented declaration could never reach the seeder");
});

// --------------------------------------------------- the unmatched-call ladder

test("a REQUIRED cross-provider call starts the provider that declares it", () => {
  // files calls /api/focus, studio-video implements it, files' own provider is
  // studio-host. Rung 2: satisfiable, not merely sayable.
  const t = tree({
    apps: { files: { provider: { package: "@x/host" }, calls: { "/api/focus": { required: true } } } },
    providers: {
      host: { package: "@x/host", run: { entry: "h.mjs" }, verbs: ["/api/files"] },
      video: { package: "@x/video", run: { entry: "v.mjs" }, verbs: ["/api/focus"] },
    },
  });
  const r = t.run(["files"]);

  assert.ok(r.providerRuns.has("@x/video"), "the provider serving a required call was not started");
  assert.equal(r.refusals.length, 0, JSON.stringify(r.refusals));
});

test("an OPTIONAL unmatched call starts NOTHING and warns", () => {
  // The discriminator. Without this the ladder could pass by starting
  // everything, which would quietly inflate what a box runs.
  const t = tree({
    apps: { files: { provider: { package: "@x/host" }, calls: { "/api/focus": { required: false } } } },
    providers: {
      host: { package: "@x/host", run: { entry: "h.mjs" }, verbs: ["/api/files"] },
      video: { package: "@x/video", run: { entry: "v.mjs" }, verbs: ["/api/focus"] },
    },
  });
  const r = t.run(["files"]);

  assert.ok(!r.providerRuns.has("@x/video"), "an optional call started a provider — only required grants that authority");
  assert.equal(r.refusals.length, 0);
  assert.ok(r.warnings.some((w) => /focus/.test(w)), "an unserved optional call must still be visible");
});

test("a REQUIRED call nothing declares REFUSES, naming the app and the verb", () => {
  const t = tree({
    apps: { files: { provider: { package: "@x/host" }, calls: { "/api/nope": { required: true } } } },
    providers: { host: { package: "@x/host", run: { entry: "h.mjs" }, verbs: ["/api/files"] } },
  });
  const r = t.run(["files"]);

  assert.equal(r.refusals.length, 1, JSON.stringify(r.refusals));
  assert.match(r.refusals[0], /files/);
  assert.match(r.refusals[0], /\/api\/nope/);
  // It must NOT promise a package to install — the box cannot name what it does
  // not have, and the spec says so rather than leaving it to be discovered.
  assert.doesNotMatch(r.refusals[0], /npm i|install @/i);
});

test("a call already served by a started provider is silent", () => {
  const t = tree({
    apps: { alpha: { provider: { package: "@x/host" }, calls: { "/api/a": { required: true } } } },
    providers: { host: { package: "@x/host", run: { entry: "h.mjs" }, verbs: ["/api/a"] } },
  });
  const r = t.run(["alpha"]);
  assert.equal(r.refusals.length, 0);
  assert.equal(r.warnings.filter((w) => /\/api\/a/.test(w)).length, 0, "a satisfied call must not warn");
});

test("required is a UNION across apps — one app needing it makes it required", () => {
  const t = tree({
    apps: {
      alpha: { provider: { package: "@x/host" }, calls: { "/api/focus": { required: false } } },
      beta: { provider: { package: "@x/host" }, calls: { "/api/focus": { required: true } } },
    },
    providers: { host: { package: "@x/host", run: { entry: "h.mjs" }, verbs: [] } },
  });
  const r = t.run(["alpha", "beta"]);
  assert.equal(r.refusals.length, 1, "one app treating it as optional must not downgrade another's hard need");
});

// ------------------------------------------------------------ verb matching

test("a trailing slash makes a verb a PREFIX; without one it is exact", () => {
  // Verbs carrying an id in the path (/api/export-status/<jobId>) cannot be
  // routed by an exact table, and reusing the byte-route rule means no second
  // syntax to learn.
  assert.equal(verbMatches("/api/export-status/", "/api/export-status/job7"), true);
  assert.equal(verbMatches("/api/health", "/api/health"), true);
  assert.equal(verbMatches("/api/health", "/api/health/deep"), false);
  assert.equal(verbMatches("/api/health", "/api/healthz"), false);
});

test("a prefix-declared verb satisfies a call to one of its children", () => {
  const t = tree({
    apps: { alpha: { provider: { package: "@x/host" }, calls: { "/api/export-status/job7": { required: true } } } },
    providers: { host: { package: "@x/host", run: { entry: "h.mjs" }, verbs: ["/api/export-status/"] } },
  });
  assert.equal(t.run(["alpha"]).refusals.length, 0, "a prefix declaration did not satisfy its child");
});

// ------------------------------------------------------------- malformed input

test("a malformed provider.json REFUSES rather than silently falling back", () => {
  const t = tree({ apps: { alpha: { provider: { package: "@x/host", run: { entry: "app.mjs" } } } } });
  const r0 = t.run(["alpha"]);
  const dir = path.dirname(path.dirname(r0.surfacesOut));   // studio/.runtime -> studio
  const appsRoot = path.join(path.dirname(dir), "apps");
  fs.mkdirSync(path.join(appsRoot, "providers", "host"), { recursive: true });
  fs.writeFileSync(path.join(appsRoot, "providers", "host", "provider.json"), "{ not json");

  const r = t.run(["alpha"]);
  assert.ok(r.refusals.some((x) => /not valid JSON/.test(x)),
    "a broken provider declaration quietly fell back to the app's copy");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
