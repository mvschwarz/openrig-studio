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

test("the generic layer ships its own visible tool language", () => {
  const source = fs.readFileSync(JS, "utf8");
  const css = fs.readFileSync(CSS, "utf8");
  for (const shape of ["circle", "rect", "arrow", "text"]) assert.ok(source.includes(shape), shape);
  assert.match(source, /isTypingTarget/);
  assert.match(source, /metaKey|ctrlKey/);
  assert.match(css, /\.studio-annotations/);
});
