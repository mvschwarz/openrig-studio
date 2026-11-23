import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { composeRail } from "../tools/compose-rail.mjs";

test("an app declares shared assets without enabling the app that originally supplied them", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-shared-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apps = path.join(root, "packages"),
    app = path.join(apps, "apps", "notes");
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(apps, "vendor", "shared"), { recursive: true });
  fs.writeFileSync(
    path.join(apps, "vendor", "shared", "privacy.js"),
    "export const privateMode = true;",
  );
  fs.writeFileSync(
    path.join(app, "app.json"),
    JSON.stringify({
      manifest_version: 1,
      id: "notes",
      name: "Notes",
      surface: { entry: "index.html", path: "/surfaces/notes.html" },
      vendor: ["shared"],
      provider: { required: false },
    }),
  );
  fs.writeFileSync(
    path.join(app, "index.html"),
    '<script type="module" src="/vendor/shared/privacy.js"></script>',
  );
  fs.writeFileSync(
    path.join(root, "studio.json"),
    JSON.stringify({ appsRoot: "packages", apps: ["notes"] }),
  );
  const run = () =>
    composeRail({
      appsRoot: apps,
      enabled: ["notes"],
      runtimeDir: path.join(root, ".runtime"),
      studioRoot: root,
    });
  assert.deepEqual(run().missing, []);
  assert.match(
    fs.readFileSync(path.join(root, ".runtime/vendor/shared/privacy.js"), "utf8"),
    /true/,
  );
  const check = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../tools/install-app.mjs", import.meta.url)), "--check", "notes"],
    { env: { ...process.env, OPENRIG_STUDIO_DIR: root }, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
  // An app-local dependency remains authoritative for existing packages.
  fs.mkdirSync(path.join(app, "vendor/shared"), { recursive: true });
  fs.writeFileSync(path.join(app, "vendor/shared/privacy.js"), "export const privateMode = false;");
  run();
  assert.match(
    fs.readFileSync(path.join(root, ".runtime/vendor/shared/privacy.js"), "utf8"),
    /false/,
  );
});
