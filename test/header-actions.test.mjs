// The header action cap is bounded, named, and NOT silent.
//
//   node --test 'test/*.test.mjs'
//
// STRUCTURAL by necessity — this repo has no browser dependency. The behaviour was
// driven in a live shell: a surface declaring eight actions rendered six, received
// {t:"header-overflow", limit:6, declared:8, dropped:["a7","a8"]}, and the console
// carried a warning naming them. What is committed here is that the cap stays
// NAMED rather than a bare literal, and that neither disclosure channel can be
// removed without a test failing.
//
// Found by studio-impl while building against it, which is the only way a silent
// cap ever gets found: the seventh button does not work and nothing says why.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = () => fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");
const doc = () => fs.readFileSync(path.join(REPO, "contract", "shell-protocol.md"), "utf8");

const renderFn = (src) => {
  const m = src.match(/function renderAppHeader\(decl\) \{([\s\S]*?)\n  \}/);
  assert.ok(m, "shell.html no longer defines renderAppHeader");
  return m[1];
};

test("the cap is a NAMED constant, not a literal buried in a slice", () => {
  // A bare `slice(0, 6)` is how this stayed undocumented: the number existed in
  // exactly one place, with no name to look up and nothing to point a doc at.
  const src = shell();
  assert.match(src, /const HEADER_ACTION_LIMIT = \d+;/,
    "the header action cap is not a named constant");
  assert.doesNotMatch(renderFn(src), /slice\(0,\s*\d+\)/,
    "renderAppHeader still slices on a bare literal — the cap has two homes again");
});

test("dropping actions is disclosed on BOTH channels", () => {
  const body = renderFn(shell());
  assert.match(body, /console\.warn/,
    "no console warning: whoever is building the app is told nothing");
  assert.match(body, /header-overflow/,
    "nothing is posted back: the APP cannot see the cap, which was the whole finding");
  assert.match(body, /dropped/,
    "the disclosure does not name which actions were dropped");
});

test("the documented limit is the limit the shell enforces", () => {
  // Two places stating one number is the drift shape this repo has paid for three
  // times. Read BOTH and compare, rather than trusting either.
  const shipped = shell().match(/const HEADER_ACTION_LIMIT = (\d+);/);
  assert.ok(shipped, "cannot read the shipped limit");
  const documented = doc().match(/header shows at most \*?\*?(\w+)/i);
  assert.ok(documented, "shell-protocol.md no longer states the header action limit");
  const words = { six: 6, seven: 7, five: 5, eight: 8, four: 4 };
  const stated = words[documented[1].toLowerCase()] ?? Number(documented[1]);
  assert.equal(stated, Number(shipped[1]),
    `the contract says ${documented[1]} header actions and the shell enforces ${shipped[1]}`);
});

test("the overflow message shape in the doc matches what the shell sends", () => {
  const body = renderFn(shell());
  const d = doc();
  for (const field of ["limit", "declared", "dropped"]) {
    assert.match(body, new RegExp(field), `the shell does not send \`${field}\``);
    assert.match(d, new RegExp(`"${field}"`), `shell-protocol.md does not document \`${field}\``);
  }
});

test("positive control: these checks can fail", () => {
  // Each assertion above is a regex over source, the shape that silently matches
  // nothing. Planted against mutated copies rather than trusted.
  const src = shell();

  const noWarn = src.replace(/console\.warn\(/g, "void(");
  assert.doesNotMatch(renderFn(noWarn), /console\.warn/,
    "the console warning survived removal, so that assertion proves nothing");

  const noPost = src.replace(/header-overflow/g, "header-nothing");
  assert.doesNotMatch(renderFn(noPost), /header-overflow/,
    "the overflow message survived removal, so that assertion proves nothing");

  const relit = src.replace(/const HEADER_ACTION_LIMIT = \d+;/, "")
                   .replace(/slice\(0, HEADER_ACTION_LIMIT\)/, "slice(0, 6)");
  assert.doesNotMatch(relit, /const HEADER_ACTION_LIMIT = \d+;/,
    "the named constant survived removal");
  assert.match(renderFn(relit), /slice\(0,\s*6\)/,
    "the bare-literal regression could not be planted, so the doesNotMatch above is untested");
});
