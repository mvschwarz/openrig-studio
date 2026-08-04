// The surface-row schema and the runtime's validation table must not drift.
//
//   node --test 'test/*.test.mjs'
//
// They are two places computing ONE property — which fields a manifest row may
// carry, and of what type. contract/surface-row.schema.json is what an author
// validates against; ROW_OPTIONAL in app/serve-studio.mjs is what actually
// decides whether a row is accepted. Nothing had ever compared them.
//
// The drift is silent AND it points the wrong way: add a field to the schema
// alone and an author following the contract writes a row the runtime reports as
// an "unknown field" — the contract says yes while the runtime shrugs. Add it to
// the runtime alone and the field works while being documented nowhere, which is
// exactly how `manifest.consumer.dir` came to ship unpromised.
//
// This is the same class as the app-manifest doc/schema guard next door, one
// layer down: prose and schema there, schema and code here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, "contract", "surface-row.schema.json"), "utf8"));
const RUNTIME = fs.readFileSync(path.join(REPO, "app", "serve-studio.mjs"), "utf8");

// The runtime's table, read from source. Parsed rather than imported because
// serve-studio.mjs starts a server on import — the same reason the declared-rows
// guard next door reads its block out of the file.
function runtimeTable() {
  const block = RUNTIME.match(/const ROW_OPTIONAL = \{([\s\S]*?)\n?\};/);
  assert.ok(block, "ROW_OPTIONAL is no longer a literal in app/serve-studio.mjs — this guard cannot read it");
  const table = {};
  for (const m of block[1].matchAll(/(\w+):\s*"(\w+)"/g)) table[m[1]] = m[2];
  return table;
}

// Fields the runtime validates by hand, ahead of the optional table.
const HANDLED_SEPARATELY = new Set(["id", "name", "path"]);
const schemaOptional = () =>
  Object.fromEntries(
    Object.entries(SCHEMA.properties)
      .filter(([name]) => !HANDLED_SEPARATELY.has(name))
      .map(([name, prop]) => [name, prop.type])
  );

test("positive control: both sides were actually read", () => {
  // Without this a regex that silently matched nothing would make every
  // comparison below pass by comparing two empty objects.
  const table = runtimeTable();
  assert.ok(Object.keys(table).length >= 5, `ROW_OPTIONAL parsed as ${JSON.stringify(table)}`);
  assert.ok(Object.keys(schemaOptional()).length >= 5, "the schema parsed with almost no properties");
});

test("the schema and the runtime accept exactly the same optional fields", () => {
  const table = runtimeTable();
  const schema = schemaOptional();

  const inSchemaOnly = Object.keys(schema).filter((k) => !(k in table));
  const inRuntimeOnly = Object.keys(table).filter((k) => !(k in schema));

  assert.deepEqual(inSchemaOnly, [],
    `the schema declares field(s) the runtime treats as unknown: ${inSchemaOnly.join(", ")} — ` +
    `an author following the contract would get a warning for a documented field`);
  assert.deepEqual(inRuntimeOnly, [],
    `the runtime accepts field(s) the schema does not declare: ${inRuntimeOnly.join(", ")} — ` +
    `a field that works while being documented nowhere is how one shipped unpromised before`);
});

test("and they agree on each field's TYPE", () => {
  // Membership alone would pass while the schema said array and the runtime
  // demanded a string, which rejects every correctly-authored row.
  const table = runtimeTable();
  for (const [name, type] of Object.entries(schemaOptional())) {
    assert.equal(table[name], type,
      `${name}: schema says ${type}, the runtime validates it as ${table[name]}`);
  }
});

test("preserve is declared, is an array, and is stable", () => {
  // The declaration this slice adds. Asserted by name because the guards above
  // would stay green if it were dropped from BOTH sides at once.
  const p = SCHEMA.properties.preserve;
  assert.ok(p, "the preserve declaration is gone from the surface-row schema");
  assert.equal(p.type, "array");
  assert.equal(p["x-stability"], "stable");
  assert.equal(runtimeTable().preserve, "array", "the runtime does not accept a declared preserve list");
});

test("every schema property carries a valid stability mark", () => {
  const CLASSES = new Set(["stable", "provisional", "runtime-internal"]);
  for (const [name, prop] of Object.entries(SCHEMA.properties)) {
    assert.ok(CLASSES.has(prop["x-stability"]),
      `${name} has x-stability ${JSON.stringify(prop["x-stability"])}, which is not a class contract-meta defines`);
  }
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
