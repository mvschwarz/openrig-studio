// Controls for the provisioner's root-kind binding.
//
//   node --test 'test/*.test.mjs'
//
// Every case below is one of review-r1's measured defeating inputs, or a
// neighbour of one found while fixing them. They are PLANTED CONTROLS: each is
// written so that the previous implementation — kinds collected into a
// space-separated string and consumed by an unquoted `for k in $ROOT_KINDS` —
// visibly fails it. A test that both implementations pass would prove nothing
// about the change, which is the whole reason these exist.
//
// The glob case plants real files in the working directory on purpose. Without
// them the old code and the new code agree, because there is nothing for a glob
// to match — the bug is invisible in an empty directory, which is exactly why it
// survived review until someone ran it somewhere real.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootBindings, conventional } from "../provision/root-bindings.mjs";

// An apps tree carrying one app that declares the given root kinds.
function appsTree(kinds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-bindings-"));
  const dir = path.join(root, "probe");
  fs.mkdirSync(dir, { recursive: true });
  // Object.create(null) HERE TOO, and the reason is worth the line: the first
  // version of this helper used a plain `{}`, so `roots["__proto__"] = …` set
  // the prototype instead of a key and the fixture silently carried no such
  // kind at all. The control for the prototype hazard was itself defeated by
  // the prototype hazard, and it failed pointing at the module rather than at
  // itself. Build the fixture the same way the code under test builds its
  // output, or the test measures something else.
  const roots = Object.create(null);
  for (const k of kinds) roots[k] = { required: true };
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify({
    manifest_version: 1, id: "probe", name: "PROBE",
    surface: { entry: "p.html", path: "/surfaces/p.html", glyph: "▣" },
    roots,
  }));
  return root;
}

const bind = (kinds, media = "/m") =>
  rootBindings({ appsDir: appsTree(kinds), media, apps: ["probe"] });

test("a kind containing a SPACE binds once, under its own name", () => {
  // r1's first measured case: the old loop word-split this into "footage" and
  // "archive" — two kinds nobody declared — and never bound the declared one.
  const { bindings } = bind(["footage archive"]);
  assert.deepEqual(Object.keys(bindings), ["footage archive"]);
  assert.equal(bindings["footage archive"], path.join("/m", "footage archive"));
  assert.ok(!("archive" in bindings), "the kind was split into pieces nobody declared");
  assert.ok(!("footage" in bindings), "a split fragment collided with a conventional kind");
});

test("a kind containing a GLOB binds literally and never reads the filesystem", (t) => {
  // r1's second and worse case: the old loop pathname-expanded "zzz*" into
  // whatever happened to sit in the provisioner's cwd, so the studio's wiring
  // depended on the directory the operator was standing in.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "glob-bait-"));
  fs.writeFileSync(path.join(cwd, "zzz1"), "bait");
  fs.writeFileSync(path.join(cwd, "zzz2"), "bait");
  const before = process.cwd();
  process.chdir(cwd);
  t.after(() => process.chdir(before));

  // The bait is real and present — confirm it, so a pass cannot be the empty
  // directory quietly agreeing with both implementations.
  assert.deepEqual(fs.readdirSync(cwd).sort(), ["zzz1", "zzz2"]);

  const { bindings } = bind(["zzz*"]);
  assert.deepEqual(Object.keys(bindings), ["zzz*"]);
  assert.ok(!("zzz1" in bindings) && !("zzz2" in bindings),
    "a filename from the working directory was bound as a declared root kind");
});

test("the four conventional kinds keep their conventional homes", () => {
  const { bindings, generated } = bind(["media", "footage", "project", "canvas"], "/m");
  // Compared by entries, and the prototype asserted separately rather than
  // incidentally: the bindings object is deliberately null-prototype, so a
  // deep-equal against an object literal fails on the prototype alone and would
  // read as a mismatch in the paths. State the property; do not let it show up
  // as noise in an unrelated assertion.
  assert.equal(Object.getPrototypeOf(bindings), null, "bindings must not inherit from Object.prototype");
  assert.deepEqual({ ...bindings }, { ...conventional("/m") });
  assert.deepEqual(generated, [], "a conventional kind must not be reported as a generated default");
});

test("an unheard-of kind binds under the media root AND is reported as generated", () => {
  // The open-vocabulary promise, and the honesty half of it: the binding is a
  // guess, so it has to say so rather than pass for a considered choice.
  const { bindings, generated } = bind(["telemetry"], "/m");
  assert.equal(bindings.telemetry, path.join("/m", "telemetry"));
  assert.deepEqual(generated, [{ kind: "telemetry", dir: path.join("/m", "telemetry") }]);
});

test("kinds named after Object internals survive instead of vanishing", () => {
  // Not one of r1's cases — found while fixing them, and the same shape: a
  // declared kind disappears while the output stays valid JSON. On a plain
  // object `bindings["__proto__"] = …` assigns nothing, and `"constructor" in
  // known` is TRUE through the prototype chain, so the kind binds to a function
  // that JSON.stringify then drops. The keys come from somebody else's
  // manifest, so neither is hypothetical.
  const { bindings } = bind(["__proto__", "constructor"], "/m");
  const round = JSON.parse(JSON.stringify(bindings));
  assert.equal(round.constructor, path.join("/m", "constructor"),
    "a kind named constructor resolved through the prototype chain");
  assert.equal(Object.keys(round).length, 2, `both kinds must survive: ${JSON.stringify(round)}`);
});

test("a declared kind whose app.json is missing is skipped, not fatal", () => {
  const r = rootBindings({ appsDir: appsTree(["media"]), media: "/m", apps: ["probe", "absent"] });
  assert.deepEqual(Object.keys(r.bindings), ["media"]);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
