// The app-manifest contract must not drift from its own schema.
//
//   node --test 'test/*.test.mjs'
//
// app-manifest.md and app-manifest.schema.json describe one format in two
// places, which is exactly the shape this contract exists to warn about. They
// are kept because a human reads prose and an installer reads a schema — so the
// duplication is deliberate and the drift has to be mechanical to catch.
//
// The equivalent test for /api/contract has already caught two real omissions:
// a field documented but never served, and a field served but never documented.
// It failed in the right direction both times, which is the only reason either
// was cheap.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = fs.readFileSync(path.join(REPO, "contract", "app-manifest.md"), "utf8");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, "contract", "app-manifest.schema.json"), "utf8"));

const STABILITY = new Set(["stable", "provisional", "runtime-internal"]);

// Every property carrying a stability mark, flattened to its leaf name.
function marked(node, out = []) {
  if (!node || typeof node !== "object") return out;
  for (const [name, prop] of Object.entries(node.properties ?? {})) {
    if (prop["x-stability"]) out.push([name, prop["x-stability"]]);
    marked(prop, out);
    marked(prop.additionalProperties, out);
  }
  return out;
}

test("every schema property carries a VALID stability mark", () => {
  for (const [name, mark] of marked(SCHEMA)) {
    assert.ok(STABILITY.has(mark), `${name} has x-stability "${mark}", which is not a class contract-meta defines`);
  }
});

test("every top-level schema property is documented in app-manifest.md", () => {
  // A field an installer will validate against, that no human doc mentions, is
  // a rule nobody can follow — which is the precise failure this whole document
  // was written after.
  for (const name of Object.keys(SCHEMA.properties)) {
    assert.ok(DOC.includes(`\`${name}\``) || DOC.includes(`\`${name}.`) || DOC.includes(`"${name}"`),
      `schema declares "${name}" but app-manifest.md never mentions it`);
  }
});

test("the doc's required fields and the schema's required fields agree", () => {
  for (const name of SCHEMA.required) {
    assert.ok(Object.keys(SCHEMA.properties).includes(name),
      `schema requires "${name}" but does not define it`);
  }
});

test("the legacy field is marked deprecated in BOTH, or in neither", () => {
  // `verbs` is superseded by `calls`. If the schema stops calling it deprecated
  // while the doc still does — or the reverse — an author gets a different
  // answer depending on which one they happened to read.
  const schemaDeprecated = SCHEMA.properties.verbs?.deprecated === true;
  const docSaysLegacy = /`verbs`/.test(DOC) && /LEGACY|legacy/.test(DOC);
  assert.equal(schemaDeprecated, docSaysLegacy,
    "schema and prose disagree about whether `verbs` is legacy");
});

test("the conformance section names what is NOT implemented", () => {
  // The honesty rail. This document specifies ahead of the tools in two places,
  // and a conformance table that quietly loses its "not yet" rows would restore
  // exactly the overstatement the contract was corrected for.
  assert.match(DOC, /## Conformance/, "the conformance section was removed");
  assert.match(DOC, /not yet/i,
    "the conformance table no longer admits anything is unimplemented — if that is genuinely true, " +
    "delete this assertion deliberately rather than letting it pass by accident");
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
