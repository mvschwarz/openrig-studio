// Finished work on the Floor, read from the page's own source: a status says only what the closed row proves, a web address in a
// result or a recorded artifact opens and nothing else becomes markup, and caller seats and the person's own seat aren't drawn
// as the rig's seats.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const floor = fs.readFileSync(new URL("../app/surfaces/floor.html", import.meta.url), "utf8");

test("a finished task's status says only what its closed row proves", () => {
  assert.doesNotMatch(floor, /nothing follows/, "a decision about this work can still be waiting");
  assert.match(floor, /'no-follow-on': 'Done'/);
  assert.match(floor, /<th>Result<\/th><th>Status<\/th><th>Artifact<\/th>/);
});

test("a web address in a finished task's result opens, and nothing else in it becomes markup", () => {
  const escapeSource = floor.slice(
    floor.indexOf("const escapeHtml ="),
    floor.indexOf("})[char]);", floor.indexOf("const escapeHtml =")) + "})[char]);".length,
  );
  const source = floor.split("\n").find((l) => l.trim().startsWith("const linked ="));
  const linked = new Function(`${escapeSource};${source};return linked`)();
  const a = (href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
  assert.equal(
    linked("PR: https://example.invalid/pull/52 is ready"),
    `PR: ${a("https://example.invalid/pull/52")} is ready`,
  );
  assert.equal(
    linked("See (https://example.invalid/x)."),
    `See (${a("https://example.invalid/x")}).`,
    "closing punctuation stays outside",
  );
  assert.equal(linked("No address here"), "No address here");
  assert.equal(
    linked("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "markup stays text",
  );
  assert.doesNotMatch(linked("javascript:alert(1)"), /<a/, "only http and https link");
  assert.doesNotMatch(
    linked('https://example.invalid/"onmouseover="x'),
    /href="[^"]*onmouseover/,
    "a quote ends the address",
  );
  assert.match(
    linked("https://example.invalid/?a=1&b=<2>"),
    /href="https:\/\/example\.invalid\/\?a=1&amp;b="/,
    "escaped in the attribute",
  );
});

test("a finished task's recorded web address opens from its Artifact cell, and any other reference stays text", () => {
  const escapeSource = floor.slice(
    floor.indexOf("const escapeHtml ="),
    floor.indexOf("})[char]);", floor.indexOf("const escapeHtml =")) + "})[char]);".length,
  );
  const source = floor.slice(
    floor.indexOf("const breakable ="),
    floor.indexOf("const done = state.done"),
  );
  const cell = new Function(
    `const unset = (t) => t; const filesHref = () => ({ hash: "", href: "" }); ${escapeSource};${source};return artifactCell`,
  )();
  const pull = "https://example.invalid/acme/app/pull/52";
  assert.equal(
    cell(pull, null),
    `<a href="${pull}" target="_blank" rel="noopener noreferrer">https:<wbr>/<wbr>/<wbr>example.invalid/<wbr>acme/<wbr>app/<wbr>pull/<wbr>52</a>`,
  );
  assert.doesNotMatch(cell("#52", null), /<a/, "a bare number can't be linked");
  assert.doesNotMatch(
    cell("/srv/outside/report.md", null),
    /<a/,
    "a path outside Files stays text",
  );
  assert.doesNotMatch(cell("javascript:alert(1)", null), /<a/, "only http and https link");
  assert.doesNotMatch(cell(`${pull} and ${pull}/files`, null), /<a/, "only a single whole address");
  assert.doesNotMatch(
    cell('https://example.invalid/"onmouseover="x', null),
    /<a/,
    "a quote isn't part of an address",
  );
  assert.match(
    cell("/work/report.md", "report.md"),
    /Open in Files/,
    "a file in Files keeps its route",
  );
  assert.equal(cell(null, null), "No file recorded");
});

test("a connected assistant's caller seats and the person's own seat aren't listed or counted as agents", () => {
  const line = floor.split("\n").find((l) => l.trim().startsWith("const isCaller ="));
  const isCaller = new Function(`${line};return isCaller`)();
  assert.equal(isCaller({ member: "caller-22bcb3457509" }), true);
  for (const member of ["lead", "build", "review", undefined])
    assert.equal(isCaller({ member }), false, String(member));
  assert.match(
    floor,
    /const team = state\.seats\.filter\(seat => seat\.customer !== true && !isCaller\(seat\)\)/,
  );
  assert.match(
    floor,
    /const seats = team\.map\(seat => `/,
    "the seats table lists the team: neither caller seats nor the person's own seat",
  );
  assert.match(floor, /<h2>Seats · \$\{team\.length\}<\/h2>/);
});
