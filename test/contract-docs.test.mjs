// The contract directory must be internally consistent.
//
//   node --test 'test/*.test.mjs'
//
// THE DEFECT THIS EXISTS FOR, and it shipped to public main: contract-meta.md
// told a reader to "See `change-signal.md`" while that file did not exist. The
// reference was added in the same commit as the feature it describes; the
// document it pointed at was still unwritten. Nothing failed, because no test
// had ever asked whether a doc's cross-references resolve.
//
// A dangling pointer in a contract is worse than a missing section. A missing
// section is visibly missing; a pointer to nothing sends a reader looking for
// authority that was never written, and it is the kind of thing a human reviewer
// skims straight past because the sentence reads perfectly well.
//
// Both checks are STRUCTURAL — a directory listing and a resolved filename —
// rather than a grep for prose. A prose check on a contract would fail on the
// document's own description of the thing it describes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(REPO, "contract");

const docs = fs.readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();

test("positive control: the contract directory has documents to check", () => {
  // Without this, an empty or mis-resolved directory makes every assertion
  // below pass vacuously — the whole suite would go green by finding nothing.
  assert.ok(docs.length >= 2, `expected several contract documents, found ${docs.length}`);
  assert.ok(docs.includes("contract-meta.md"), "contract-meta.md is the index; it must be here");
});

test("every contract document is listed in contract-meta's documents table", () => {
  // An unindexed document is one a reader never finds. The table is the only
  // place that claims to enumerate them, so it is the thing that has to stay
  // true when a document is added.
  const meta = fs.readFileSync(path.join(DIR, "contract-meta.md"), "utf8");
  const table = meta.match(/## The documents\n([\s\S]*?)\n## /);
  assert.ok(table, "contract-meta.md no longer has a `## The documents` section to check");

  for (const doc of docs) {
    assert.ok(table[1].includes(`\`${doc}\``),
      `${doc} exists but contract-meta.md's documents table does not list it — ` +
      `a document nobody is pointed at is a document nobody reads`);
  }
});

test("every .md a contract document points at actually exists", () => {
  // THE REGRESSION. Reference forms in use are the bare filename and the
  // repo-relative path, so both are resolved.
  const missing = [];
  for (const doc of docs) {
    const body = fs.readFileSync(path.join(DIR, doc), "utf8");
    for (const m of body.matchAll(/`(?:contract\/)?([A-Za-z0-9._-]+\.md)`/g)) {
      const target = m[1];
      if (!fs.existsSync(path.join(DIR, target))) missing.push(`${doc} -> ${target}`);
    }
  }
  assert.deepEqual(missing, [],
    `a contract document points at a file that does not exist: ${missing.join(", ")}`);
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
