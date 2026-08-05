import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE = path.join(REPO, "apps", "artifacts", "app", "artifacts.html");
const APP = path.join(REPO, "apps", "artifacts", "app.json");
const PROVIDER = path.join(REPO, "providers", "studio-artifacts", "provider.json");
const SERVER = path.join(REPO, "providers", "studio-artifacts", "artifacts-server.mjs");

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

async function startProvider(root) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, "--port", String(port), "--root", root], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (chunk) => { log += chunk; });
  proc.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (proc.exitCode != null) throw new Error(`provider exited ${proc.exitCode}:\n${log}`);
    try {
      const response = await fetch(origin);
      if (response.ok) return { proc, origin };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  proc.kill();
  throw new Error(`provider did not start:\n${log}`);
}

const json = async (response) => {
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
};

test("ARTIFACTS refines the SDK annotation context instead of shipping a second annotation layer", () => {
  const surface = fs.readFileSync(SURFACE, "utf8");
  const app = JSON.parse(fs.readFileSync(APP, "utf8"));
  const provider = JSON.parse(fs.readFileSync(PROVIDER, "utf8"));

  assert.match(surface, /t:\s*["']annotation-context["']/);
  assert.match(surface, /t:\s*["']annotation-target["']\s*,\s*frame:\s*state\.current\s*\?\s*["']artifactFrame["']/,
    "the surface names its same-origin content frame without composing the target itself");
  assert.match(surface, /t:\s*["']annotation-refresh["']/,
    "canvas geometry changes must tell the SDK layer to re-measure anchored marks");
  assert.match(surface, /parent\.studioAnnotations/);
  assert.doesNotMatch(surface, /class=["'][^"']*draw-tool/,
    "ARTIFACTS must not retain its private annotation toolbar beside the SDK MARKUP control");
  assert.doesNotMatch(surface, /class=["'][^"']*annotation-list/,
    "ARTIFACTS must not retain a second annotation thread beside the SDK thread");
  assert.ok(app.calls["/api/annotations"], "the app declares the SDK-shaped annotation store it consumes");
  assert.ok(provider.verbs.includes("/api/annotations"), "the provider serves the substitutable SDK annotation verb");
});

test("the provider migrates legacy marks into opaque isolated scopes exactly once", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-artifacts-annotations-"));
  const server = await startProvider(root);
  t.after(() => { server.proc.kill(); fs.rmSync(root, { recursive: true, force: true }); });

  const created = await json(await fetch(`${server.origin}/api/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "page-one", name: "Page one", html: "<button id='publish'>Publish</button>" }),
  }));
  assert.equal(created.artifact.id, "page-one", "positive control: the real provider created the artifact");

  const legacy = [{
    id: "legacy-1", shape: "circle", note: "Make this primary", source: "agent",
    selector: "#publish", anchor: { x: .2, y: .3, width: .2, height: .1 },
    offset: { x: .01, y: .02, width: .03, height: .04 }, status: "anchored",
  }];
  fs.writeFileSync(path.join(root, "page-one", "annotations.json"), `${JSON.stringify(legacy, null, 2)}\n`);

  const scopeOne = "artifacts\u0000page-one";
  const migrated = await json(await fetch(`${server.origin}/api/artifacts/annotations/migrate?artifact=page-one`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: scopeOne }),
  }));
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.records[0].id, "legacy-1");
  assert.deepEqual(migrated.records[0].offset, legacy[0].offset,
    "moving an anchored legacy mark must not lose its size offset during migration");

  const firstRead = await json(await fetch(`${server.origin}/api/annotations?scope=${encodeURIComponent(scopeOne)}`));
  assert.equal(firstRead.records.length, 1);

  await json(await fetch(`${server.origin}/api/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: scopeOne, records: [] }),
  }));
  const repeated = await json(await fetch(`${server.origin}/api/artifacts/annotations/migrate?artifact=page-one`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: scopeOne }),
  }));
  assert.equal(repeated.migrated, false, "deleting every migrated mark must not resurrect the legacy file");
  assert.deepEqual(repeated.records, []);

  const scopeTwo = "artifacts\u0000page-two";
  await json(await fetch(`${server.origin}/api/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: scopeTwo, records: [{ id: "other", shape: "rect" }] }),
  }));
  const isolated = await json(await fetch(`${server.origin}/api/annotations?scope=${encodeURIComponent(scopeOne)}`));
  assert.deepEqual(isolated.records, [], "one artifact's board must not bleed into another opaque scope");
});
