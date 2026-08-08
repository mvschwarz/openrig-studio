import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS = path.join(REPO, "app", "annotations.js");
const CSS = path.join(REPO, "app", "annotations.css");

test("annotations are one shell feature, not an ARTIFACTS fork", () => {
  const source = fs.readFileSync(JS, "utf8");
  assert.match(source, /export function attach\s*\(shell/);
  assert.match(source, /shell\.overlay/);
  assert.match(source, /shell\.active\(\)/);
  assert.match(source, /shell\.onMarkup/);
  assert.match(source, /shell\.onSurface/);
  assert.doesNotMatch(source, /artifacts?|\/api\//i);
});

test("persistence is injected and absence is disclosed", () => {
  const source = fs.readFileSync(JS, "utf8");
  assert.match(source, /store\?\.load/);
  assert.match(source, /store\?\.save/);
  assert.match(source, /session only/i);
});

test("the 'persisted' label follows the DISCLOSURE, never the presence of a store", async () => {
  // review.r2 CRITICAL: the default in-memory runtime is write-capable, so the
  // shell built a store and the layer reduced persistence to Boolean(store) and
  // rendered "persisted" — over marks that vanish on restart. PM: severe, a
  // false durability claim is the kind users discover by losing work. The label
  // must read meta.annotations.persistence, not the store's presence.
  const { marksPersist } = await import("../app/annotations.js");
  const store = { load() {}, save() {} };

  // THE BUG, pinned: a store exists (write-capable) but persistence is "memory".
  // Boolean(store) === true would show "persisted"; the disclosure says no.
  assert.equal(marksPersist(store, "memory"), false,
    "a memory-backed runtime is shown as persisted — marks vanish on restart and the user is not told");
  assert.equal(marksPersist(store, "file"), true, "a file-backed runtime must read persisted");
  assert.equal(marksPersist(null, "file"), false, "no store, yet claimed persisted");
  // Fail-safe: an unrecognised or absent disclosure reads session-only, because
  // a false "persisted" costs work and a false "session only" costs nothing.
  assert.equal(marksPersist(store, "future-durable-mode"), false, "unrecognised disclosure did not fail safe");
  assert.equal(marksPersist(store, null), false, "absent disclosure did not fail safe");
  assert.equal(marksPersist(store, undefined), false);
});

test("the shell forwards the persistence disclosure into the layer, not just the store", () => {
  // The other half: the fix is only real if the shell actually passes the
  // disclosure. A grep guard so a future edit that drops it fails here rather
  // than silently reverting to Boolean(store).
  const shell = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");
  assert.match(shell, /attach\(window\.studioShell,\s*\{[^}]*persistence:\s*meta\?\.annotations\?\.persistence/,
    "the shell no longer forwards meta.annotations.persistence — the label falls back to store presence");
});

test("the generic layer ships its own visible tool language", () => {
  const source = fs.readFileSync(JS, "utf8");
  const css = fs.readFileSync(CSS, "utf8");
  for (const shape of ["circle", "rect", "arrow", "text"]) assert.ok(source.includes(shape), shape);
  assert.match(source, /isTypingTarget/);
  assert.match(source, /metaKey|ctrlKey/);
  assert.match(css, /\.studio-annotations/);
});
