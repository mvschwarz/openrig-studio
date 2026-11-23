// The comment check refuses history in comments (ticket ids, dated stamps, signed TODOs), applies a private list when one is given,
// and leaves ordinary code alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commentText,
  findViolations,
  loadPrivateRules,
  PUBLIC_RULES,
} from "../scripts/check-comments.mjs";

// Built from pieces so this file does not trip the check it tests.
const ticket = "ABC" + "-123";
const date = "2026-" + "11-22";
const todo = "TODO" + "(alex)";

test("ticket ids, dated stamps and signed TODOs are refused in comments", () => {
  for (const line of [
    `// see ${ticket}`,
    `// changed ${date}`,
    `/* ${todo}: tidy */`,
    `# changed ${date}`,
    `<!-- ${date} -->`,
  ]) {
    const file = line.startsWith("#") ? "x.sh" : line.startsWith("<!--") ? "x.html" : "x.mjs";
    assert.equal(findViolations(line, file).length, 1, line);
  }
  assert.equal(findViolations(`/* changed\n   ${date} */`, "x.mjs").length, 1);
});

test("a time of day in UTC is refused in comments; a full timestamp and code pass", () => {
  // Built from pieces so this file does not trip the check it tests.
  const at = "05:" + "20Z";
  const about = "03:" + "2xZ";
  for (const line of [
    `// joins asked for by the owner (${at})`,
    `// settled ${about}`,
    `# at ${at}`,
  ]) {
    const file = line.startsWith("#") ? "x.sh" : "x.mjs";
    assert.deepEqual(
      findViolations(line, file).map((h) => h.what),
      ["time stamp"],
      line,
    );
  }
  assert.deepEqual(findViolations(`// an expiry like 12:00:` + `00Z is fine`, "x.mjs"), []);
  assert.deepEqual(findViolations(`const t = "${at}";`, "x.mjs"), []);
  assert.deepEqual(findViolations("// ratio 1:20Z-score", "x.mjs"), []);
});

test("the same shapes in code, and standards names in comments, pass", () => {
  assert.deepEqual(
    findViolations(`const at = "${date}T00:00:00Z"; const id = "${ticket}";`, "x.mjs"),
    [],
  );
  assert.deepEqual(
    findViolations(
      "// decode as UTF-8, hash with SHA-256, dates as ISO-8601, copy with OSC-52",
      "x.mjs",
    ),
    [],
  );
  assert.deepEqual(findViolations("// TODO: a plain todo is fine", "x.mjs"), []);
});

test("ordinary code and URLs pass", () => {
  const code = [
    'const url = "http://127.0.0.1:8890/"; // the default port',
    "/* a block comment about why */",
    "const crossOwner = owner !== other;",
  ].join("\n");
  assert.deepEqual(findViolations(code, "x.mjs"), []);
  assert.deepEqual(
    commentText(code, "x.mjs").map((s) => s.trim()),
    ["the default port", "a block comment about why", ""],
  );
});

test("a private list adds rules, anywhere or in comments only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  const file = path.join(dir, "private.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      { what: "person reference", pattern: "\\bAl" + "ex\\b", scope: "anywhere" },
      { what: "team name", pattern: "\\bteam-" + "blue\\b", flags: "i", scope: "comments" },
    ]),
  );
  const rules = [...PUBLIC_RULES, ...loadPrivateRules(file)];
  assert.equal(findViolations('const who = "Al' + 'ex";', "x.mjs", rules).length, 1);
  assert.equal(findViolations("// asked by Team-" + "Blue", "x.mjs", rules).length, 1);
  assert.deepEqual(findViolations('const t = "team-' + 'blue";', "x.mjs", rules), []);
  assert.deepEqual(
    findViolations('const who = "Al' + 'ex";', "x.mjs"),
    [],
    "public rules alone don't know the name",
  );
});

test("a malformed private list is refused with a reason", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-"));
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, JSON.stringify([{ pattern: "x" }]));
  assert.throws(() => loadPrivateRules(file), /needs "what" and "pattern"/);
  fs.writeFileSync(file, "{}");
  assert.throws(() => loadPrivateRules(file), /expected a JSON list/);
});
