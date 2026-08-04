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

test("every contract document is listed in contract-meta's documents TABLE", () => {
  // An unindexed document is one a reader never finds. The table is the only
  // place that claims to enumerate them, so it is the thing that has to stay
  // true when a document is added.
  //
  // ROWS ONLY, and that is a correction rather than a detail. This first read the
  // whole SECTION, so a document merely NAMED in the prose above the table
  // satisfied a check whose failure message says the table lists it. Caught by
  // planting the removal of a row and watching it stay green — the prose
  // introducing that same document was enough. A guard whose message and whose
  // assertion disagree is worse than none, because the message is what a reader
  // believes.
  const meta = fs.readFileSync(path.join(DIR, "contract-meta.md"), "utf8");
  const section = meta.match(/## The documents\n([\s\S]*?)\n## /);
  assert.ok(section, "contract-meta.md no longer has a `## The documents` section to check");

  const rows = section[1].split("\n").filter((l) => l.trimStart().startsWith("|"));
  assert.ok(rows.length >= 3, `the documents table parsed as ${rows.length} row(s) — the shape changed`);

  for (const doc of docs) {
    assert.ok(rows.some((r) => r.includes(`\`${doc}\``)),
      `${doc} exists but contract-meta.md's documents table does not list it — ` +
      `a document nobody is pointed at is a document nobody reads ` +
      `(a mention in the surrounding prose does not count)`);
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

test("the README's stated package version is the version package.json ships", () => {
  // A VERSION NUMBER IN PROSE IS A CLAIM ABOUT THE REPO, SO IT GOES STALE ON
  // SUCCESS — the same shape as every status line this repository has been
  // catching, and it fired here. The README said "Package 0.4.0" for two
  // delivered slices after 0.4.0 was tagged. Nothing failed, because the two
  // places that state the version had nothing comparing them.
  //
  // That is this repo's own recurring class: one property computed in two places
  // with no check between them. The remedy is the cheap one — read both and
  // compare — because the expensive part was never the check, it was noticing.
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const shipped = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

  const stated = readme.match(/^Package (\d+\.\d+\.\d+)\./m);
  assert.ok(stated, "the README no longer states a package version in the form `Package X.Y.Z.`");
  assert.equal(stated[1], shipped,
    `the README says Package ${stated[1]} but package.json ships ${shipped} — ` +
    `the front door is making a claim about the repo that the repo does not support`);
});

test("no shipped doc hardcodes a package version — they go stale on release", () => {
  // FOUND IN A COLD BUILD: the skill said "@openrig/studio is at 0.4.0" while the
  // shipped package was 0.6.0, and a second stale 0.4.0 was hiding in
  // shell-contract.md. Both were true when written. A package number in prose is
  // a claim about the repo, so it goes stale ON RELEASE — the same shape as the
  // README version this suite already guards, in the docs an agent is told to
  // read FIRST.
  //
  // The README is the ONE place allowed to state it, because a guard keeps it
  // honest. Everywhere else the remedy is not to update the number but to stop
  // stating it: reference-not-restate. Two-part contract versions (0.1) are
  // deliberately not matched — the contract version is stable and stating it is
  // the whole point.
  const roots = [path.join(REPO, "skills"), DIR];
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md")) files.push(full);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);

  assert.ok(files.length >= 5,
    `positive control: only ${files.length} docs found, so this guard is checking almost nothing`);

  const offenders = [];
  for (const f of files) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      // Strip IPv4 first — 127.0.0.1 contains a three-part run and is not a version.
      for (const m of line.replace(/\b\d+\.\d+\.\d+\.\d+\b/g, "").matchAll(/\b\d+\.\d+\.\d+\b/g)) {
        offenders.push(`${path.relative(REPO, f)}:${i + 1} — ${m[0]}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `a shipped doc states a package version that will be wrong at the next release; ` +
    `reference it (\`require('@openrig/studio/package.json').version\`) instead of restating it: ` +
    offenders.join(", "));
});

// NOT GUARDED, DELIBERATELY, AND THE ATTEMPT IS WORTH RECORDING. The other half
// of the same staleness was the README advertising focus and the change signal as
// "not in the SDK yet" after both shipped — the front door telling a reader the
// truth backwards. A guard for it was written and then REMOVED, because it could
// only ask whether the section MENTIONS a primitive, and the honest section
// mentions focus while explaining why agent-drives-the-app was split from it. It
// failed on correct content the first time it was run against it.
//
// That is a checker misfiring on the DESCRIPTION of the property it checks, which
// this repository has already ruled is worse than no checker: it fails toward
// looking-like-a-finding, and the fix a reader reaches for is to reword honest
// prose until the tool stops complaining.
//
// The mechanical half — a version number stated in two places — is checked above
// because it is structure. Whether a paragraph's claims are true is what a
// reviewer is for, and pretending otherwise would be the kind of decoration that
// gets counted as evidence.

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
