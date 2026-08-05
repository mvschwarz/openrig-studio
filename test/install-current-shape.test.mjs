// The installer accepts an app built to the CURRENT contract.
//
//   node --test 'test/*.test.mjs'
//
// WHY THIS EXISTS. A QA seat built artifacts to the shipped app-manifest contract
// — a provider REFERENCE with no app-level `run`/`verbs`, `calls{}`, and a root
// kind the SDK had never heard of — and an installer refused it before copying
// anything. The installer it hit was a stale local copy, not this one. But the
// reason nobody knew that is the interesting part: THIS repository's own
// conformance table said `install-app.mjs --check` still "validates the older
// shape", which had stopped being true, and a reader who believes a capability is
// missing goes and writes a workaround. A doc that understates the product costs
// as much as one that overstates it, in a different direction.
//
// So the row now says yes, and this is what keeps it honest: the claim is
// exercised rather than asserted, against a real app tree with a real invocation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "tools", "install-app.mjs");

// An app in the shape contract/app-manifest.md documents TODAY: the app declares
// a provider REFERENCE and nothing about how to run it, because how to run is the
// provider's fact.
function studio({ bindRoot = true, withProviderJson = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-shape-"));
  const apps = path.join(dir, "apps");
  fs.mkdirSync(path.join(apps, "apps", "artifacts", "app"), { recursive: true });
  fs.mkdirSync(path.join(apps, "providers", "studio-artifacts"), { recursive: true });
  const rootDir = path.join(dir, "artifacts-root");
  fs.mkdirSync(rootDir);

  fs.writeFileSync(path.join(apps, "apps", "artifacts", "app", "artifacts.html"), "<!doctype html><title>A</title>");
  fs.writeFileSync(path.join(apps, "apps", "artifacts", "app.json"), JSON.stringify({
    manifest_version: 1,
    id: "artifacts",
    name: "ARTIFACTS",
    surface: { entry: "app/artifacts.html", path: "/surfaces/artifacts.html", glyph: "◈", hint: "built artifacts" },
    provider: { package: "studio-artifacts", required: true },
    // A KIND THE SDK HAS NEVER HEARD OF. The vocabulary is open by decision; an
    // app needing any other kind of directory used to be uninstallable.
    roots: { artifacts: { required: true } },
    calls: { "/api/artifacts/list": { required: true }, "/api/focus": { required: false } },
  }, null, 2));

  if (withProviderJson) {
    fs.writeFileSync(path.join(apps, "providers", "studio-artifacts", "provider.json"), JSON.stringify({
      manifest_version: 1,
      id: "studio-artifacts",
      run: { entry: "artifacts-server.mjs", port_env: "ARTIFACTS_PORT" },
      serves: ["/artifacts/"],
      verbs: ["/api/artifacts/"],
    }, null, 2));
    fs.writeFileSync(path.join(apps, "providers", "studio-artifacts", "artifacts-server.mjs"), "// provider\n");
  }

  fs.writeFileSync(path.join(dir, "studio.json"), JSON.stringify({
    appsRoot: apps,
    roots: bindRoot ? { artifacts: rootDir } : {},
  }, null, 2));
  return dir;
}

const check = (dir) => {
  try {
    return { out: execFileSync(process.execPath, [INSTALLER, "--check", "artifacts"],
      { encoding: "utf8", env: { ...process.env, OPENRIG_STUDIO_DIR: dir } }), threw: false };
  } catch (e) {
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, threw: true };
  }
};

test("an app in the CURRENT shape installs — provider reference, calls{}, a novel root kind", () => {
  const { out } = check(studio());
  assert.match(out, /OK — installable from its manifest/,
    `an app built to the shipped contract was refused:\n${out}`);
  assert.match(out, /runnable — declared by studio-artifacts \(provider\.json\)/,
    "the app declared no run of its own, so the provider declaration is what must satisfy this");
  assert.match(out, /root "artifacts" binds/,
    "a root kind the SDK does not enumerate must still bind — the vocabulary is open by decision");
});

test("negative control: a declared root kind nobody bound is still REFUSED", () => {
  // Opening the vocabulary must not mean accepting anything. Without this, the
  // test above passes just as happily against an installer that checks nothing.
  const { out } = check(studio({ bindRoot: false }));
  assert.match(out, /REFUSED/, `an unbound root kind was accepted:\n${out}`);
  assert.match(out, /root "artifacts" has no binding/);
});

test("negative control: a provider reference with no provider.json is REFUSED", () => {
  // The other way the first test could pass for the wrong reason — an installer
  // that accepts a provider reference without ever resolving it.
  const { out } = check(studio({ withProviderJson: false }));
  assert.match(out, /REFUSED/, `an unresolvable provider reference was accepted:\n${out}`);
  assert.match(out, /does not declare how to run/);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
