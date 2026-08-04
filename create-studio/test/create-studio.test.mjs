// Regression suite for create-studio. Zero dependencies — node:test only.
//
//   node --test create-studio/test/
//
// Two things the
// original ad-hoc smoke testing missed, and which this suite exists to keep
// missing-proof:
//
//   1. Option VALUES were never exercised. Admission was covered thoroughly, so
//      the harness looked strong, but `--hint 'say "hello"'` emitted invalid
//      JSON while the CLI exited 0. Every user-controlled field is now run
//      through a hostile-value matrix.
//   2. Nothing ran twice. A manual pass is not regression coverage: it
//      does not run tomorrow.
//
// Assertion discipline: assert on CONTENT, never on exit status alone. A test
// that only checks a non-zero exit passes just as happily on a syntax error in
// the CLI as on a correct rejection. Rejection tests therefore assert the
// expected REASON, and `positive control` proves the suite can actually fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const CLI = path.join(PKG, "index.mjs");
const SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(PKG, "..", "contract", "surface-row.schema.json"), "utf8")
);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "create-studio-test-"));

function run(args, { cwd, env } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: cwd ?? os.tmpdir(),
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const emitted = (dir, name) => ({
  row: JSON.parse(fs.readFileSync(path.join(dir, name, "surfaces.row.json"), "utf8")),
  html: fs.readFileSync(path.join(dir, name, `${name}.html`), "utf8"),
  surfaces: JSON.parse(fs.readFileSync(path.join(dir, name, "surfaces.json"), "utf8")),
  readme: fs.readFileSync(path.join(dir, name, "README.md"), "utf8"),
});

// Entries left behind under a parent, ignoring nothing — staging directories are
// hidden, so a naive readdir that skipped dotfiles would hide exactly the
// failure this checks for.
const entries = (dir) => fs.readdirSync(dir);

// ---------------------------------------------------------------- generation

test("emits a runnable project and reports success", () => {
  const dir = tmp();
  const r = run(["my-surface", "--dir", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(dir, "my-surface")).sort(),
    [".gitignore", "README.md", "my-surface.html", "studio.json", "surfaces.json", "surfaces.row.json"]);
  assert.match(r.stdout, /created/);
});

test("emitted row is schema-shaped: required present, exactly one target, stable fields only", () => {
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir]).code, 0);
  const { row } = emitted(dir, "my-surface");

  for (const key of SCHEMA.required) assert.ok(key in row, `missing required field ${key}`);
  assert.ok(("path" in row) !== ("url" in row), "must carry exactly one of path|url");

  for (const key of Object.keys(row)) {
    const prop = SCHEMA.properties[key];
    assert.ok(prop, `emitted unknown field ${key}`);
    assert.equal(prop["x-stability"], "stable",
      `emitted ${key}, which is ${prop["x-stability"]} — the scaffolder emits stable fields only`);
  }
  assert.match(row.path, /^\//);
});

test("emitted surface targets the contract version and only stable endpoints", () => {
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir]).code, 0);
  const { html } = emitted(dir, "my-surface");

  assert.match(html, /const TARGET_CONTRACT = "0\.1"/);
  // An ALLOWLIST, so a new endpoint has to be admitted deliberately rather than
  // drifting into every scaffolded surface. `/api/drive` was added when the
  // scaffolder became drivable: it is stable in contract/drive.md, and this guard
  // correctly refused it until someone said so here.
  const STABLE = ["/api/contract", "/api/factory/state", "/api/events", "/api/drive"];
  const endpoints = [...html.matchAll(/\/api\/[a-z/]+/g)].map((m) => m[0]);
  for (const e of new Set(endpoints)) {
    assert.ok(STABLE.includes(e), `emitted a non-stable endpoint: ${e}`);
  }
  // runtime-internal surfaces named in contract/runtime-api.md must never appear
  assert.doesNotMatch(html, /files\/(write|goto|roots)|sidebar-arrangement|oauth|credential/i);
});

test("the emitted surface ADOPTS the runtime helper and can show a degraded state", () => {
  // A review found the SDK shipped the change-signal helper with ZERO surfaces
  // using it — every reference outside the helper itself was in a test. The
  // scaffolder is the highest-leverage place to fix that: every surface anyone
  // generates from here gets the primitive, which is the whole thesis of
  // shipping it. This asserts it stays adopted rather than trusting it to.
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir]).code, 0);
  const { html } = emitted(dir, "my-surface");

  assert.match(html, /import \{[^}]*watchSignal[^}]*\} from "\/signal\.js"/,
    "the emitted surface no longer imports the runtime helper");
  // An import only works from a module, so this is load-bearing rather than style.
  assert.match(html, /<script type="module">/,
    "the surface imports a module from a classic script, which cannot execute");
  // Degraded must be visible in the UI, not only in the console
  // (contract/shell-protocol.md), so there has to be somewhere to show it.
  assert.match(html, /id="degraded"/, "the emitted surface has nowhere to render a degraded state");
  assert.match(html, /onDegraded/, "the surface imports the helper but never asks to be told about failure");
});

test("the emitted README documents the primitives the emitted PAGE already uses", () => {
  // FOUND IN A COLD BUILD. The generated project's own README pointed at four
  // contract documents and never mentioned focus.md or drive.md — while the page
  // beside it already called driveSurface. A stranger reading their own generated
  // code found a helper their own README did not document.
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir]).code, 0);
  const { html, readme } = emitted(dir, "my-surface");

  // Keyed on what the PAGE actually imports, so this cannot drift into a fixed
  // list that stops matching the code it describes.
  const imported = (html.match(/import \{([^}]*)\} from "\/signal\.js"/) || [, ""])[1]
    .split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(imported.length >= 2, `positive control: parsed ${imported.length} imports from the page`);

  for (const fn of imported) {
    assert.ok(readme.includes(fn),
      `the emitted page imports ${fn} but the emitted README never mentions it — ` +
      `the code does something the shipped docs do not explain`);
  }
  for (const doc of ["change-signal.md", "focus.md", "drive.md"]) {
    assert.ok(readme.includes(doc), `the emitted README does not point at contract/${doc}`);
  }
});

test("the emitted README names the file that was actually emitted", () => {
  // The template's own filename leaked into the docs of every generated project:
  // the README said `surface.html` while the emitted file is <name>.html, in a
  // document where every other reference is correctly interpolated.
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir]).code, 0);
  const { readme } = emitted(dir, "my-surface");

  assert.ok(readme.includes("my-surface.html"), "the README never names the emitted page");
  assert.ok(!/`surface\.html`/.test(readme),
    "the emitted README refers to `surface.html`, which is the TEMPLATE's name and does not exist here");
  assert.ok(!readme.includes("{{"), "an unreplaced template token reached the emitted README");
});

test("the emitted surface is AGENT-DRIVABLE out of the box", () => {
  // Same argument as the helper above, one primitive along. A drive channel the
  // SDK ships and no surface adopts is a channel every application reinvents
  // differently — which is the state this primitive was written to end.
  //
  // Asserted on the emitted page rather than on the template, because the template
  // is not what anyone runs.
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir]).code, 0);
  const { html } = emitted(dir, "my-surface");

  assert.match(html, /import \{[^}]*driveSurface[^}]*\} from "\/signal\.js"/,
    "the emitted surface no longer imports the drive helper");
  assert.match(html, /driveSurface\(\{/, "the surface imports the drive helper but never adopts it");
  assert.match(html, /apply:/, "the drive adoption has no apply, so an op would land nowhere");

  // The ops it claims to handle must be ones it CAN handle. A starter advertising
  // a vocabulary it does not implement would report success for things it does not
  // do — worse than offering less.
  for (const [op, capability] of [["op.refresh", "refresh"], ["op.say", "showNotice"]]) {
    assert.ok(html.includes(op), `the drive adoption does not handle ${op}`);
    assert.ok(html.includes(capability + "("),
      `${op} is handled but the surface has no ${capability}() to honour it with`);
  }
});

// ------------------------------------------------------------------ escaping
// The regression that produced this suite. Every user-controlled field crossed
// with every metacharacter class that has a different meaning in JSON, HTML or
// Markdown.

const HOSTILE = [
  ['double quote', 'say "hello" now'],
  ['backslash', "back\\slash and \\\" mix"],
  ['newline', "line one\nline two"],
  ['html metachars', '<strong>OWNED</strong> & <img src=x onerror=alert(1)>'],
  ['markdown fence', "```json\nnot really\n```"],
  ['json braces', '{"injected": true}'],
  ['unicode + quote', '◆ "◆" ◆'],
];

for (const [label, value] of HOSTILE) {
  test(`hint survives ${label} in every output context`, () => {
    const dir = tmp();
    const r = run(["my-surface", "--dir", dir, "--hint", value]);
    assert.equal(r.code, 0, r.stderr);

    // JSON context: must parse, and must round-trip the value EXACTLY.
    const { row, html, readme } = emitted(dir, "my-surface");
    assert.equal(row.hint, value, "hint did not round-trip through the emitted JSON");

    // HTML context: no raw markup may survive into the document.
    assert.doesNotMatch(html, /<strong>OWNED<\/strong>/);
    assert.doesNotMatch(html, /<img src=x/);

    // Markdown context: the fenced blocks in the README must still be balanced.
    // Fences here are list-indented, so anchor on optional leading whitespace —
    // matching only column-0 fences would silently skip them.
    const fences = (readme.match(/^\s*```/gm) || []).length;
    assert.equal(fences % 2, 0, "emitted README has an unbalanced code fence");

    // The README's inline row must still be parseable JSON, and must be indented
    // consistently — a ragged block is what a developer copy-pastes out.
    const block = readme.match(/```json\n([\s\S]*?)\n\s*```/);
    assert.ok(block, "emitted README lost its json block");
    const lines = block[1].split("\n");
    const indent = (l) => l.match(/^ */)[0].length;
    assert.equal(indent(lines[0]), indent(lines[lines.length - 1]),
      "json block is ragged: opening and closing braces are at different indents");
    JSON.parse(block[1]);
  });
}

for (const [label, value] of [['double quote', '"'], ['backslash', "\\"], ['newline', "\n"], ['angle bracket', "<"]]) {
  test(`glyph survives ${label}`, () => {
    const dir = tmp();
    const r = run(["my-surface", "--dir", dir, "--glyph", value]);
    assert.equal(r.code, 0, r.stderr);
    const { row } = emitted(dir, "my-surface");
    assert.equal(row.glyph, value, "glyph did not round-trip through the emitted JSON");
  });
}

test("negative control: a plain hint also passes (the matrix is not vacuously green)", () => {
  const dir = tmp();
  assert.equal(run(["my-surface", "--dir", dir, "--hint", "plain text"]).code, 0);
  assert.equal(emitted(dir, "my-surface").row.hint, "plain text");
});

// ----------------------------------------------------------------- admission

const REJECTIONS = [
  ["traversal", ["../evil"], /single path segment/],
  ["absolute path", ["/tmp/evil"], /must not be an absolute/],
  ["nested segment", ["a/b"], /single path segment/],
  ["uppercase and punctuation", ["My Surface!"], /lowercase letters/],
  ["empty name", [""], /project name is required/],
  ["missing name", [], /project name is required/],
  ["parent traversal name", [".."], /must not start with/],
  ["leading dot", [".hidden"], /must not start with/],
  ["reserved device name", ["con"], /is reserved/],
  ["tilde", ["~evil"], /must not start with/],
  ["trailing dash", ["bad-"], /lowercase letters/],
  ["over-long name", ["a".repeat(65)], /characters; the limit/],
];

for (const [label, args, expected] of REJECTIONS) {
  test(`rejects ${label} and writes nothing`, () => {
    const dir = tmp();
    const r = run([...args, "--dir", dir]);
    assert.notEqual(r.code, 0, `expected rejection for ${label}`);
    assert.match(r.stderr, expected, `wrong reason for ${label}: ${r.stderr}`);
    assert.deepEqual(entries(dir), [], "a rejected run must leave the filesystem untouched");
  });
}

test("rejects a multi-character glyph", () => {
  const dir = tmp();
  const r = run(["ok-name", "--dir", dir, "--glyph", "ab"]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /exactly one character/);
  assert.deepEqual(entries(dir), []);
});

test("rejects an option missing its value, and an unknown option", () => {
  const dir = tmp();
  assert.match(run(["ok-name", "--dir"]).stderr, /needs a value/);
  const r = run(["ok-name", "--bogus", "--dir", dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unknown option/);
  assert.deepEqual(entries(dir), []);
});

test("refuses a non-empty destination and leaves its contents intact", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "occupied"));
  fs.writeFileSync(path.join(dir, "occupied", "keep.txt"), "existing work");
  const r = run(["occupied", "--dir", dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /is not empty/);
  assert.equal(fs.readFileSync(path.join(dir, "occupied", "keep.txt"), "utf8"), "existing work");
  assert.deepEqual(fs.readdirSync(path.join(dir, "occupied")), ["keep.txt"]);
});

test("accepts an existing EMPTY destination", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "empty-dest"));
  const r = run(["empty-dest", "--dir", dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, "empty-dest", "empty-dest.html")));
});

test("refuses a destination whose parent does not exist", () => {
  const r = run(["my-surface", "--dir", path.join(tmp(), "nope")]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /parent does not exist/);
});

// ------------------------------------------------------------------ atomicity

test("a mid-generation failure leaves no project and no staging residue", () => {
  const dir = tmp();
  const r = run(["halfway", "--dir", dir], { env: { OPENRIG_STUDIO_CREATE_FAIL_AFTER: "2" } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /nothing was written/);
  assert.deepEqual(entries(dir), [],
    "destination or hidden staging directory survived a failed generation");
});

test("failure injection is inert when unset (the atomicity test is not self-fulfilling)", () => {
  const dir = tmp();
  assert.equal(run(["halfway", "--dir", dir]).code, 0);
  assert.ok(fs.existsSync(path.join(dir, "halfway", "halfway.html")));
});

// -------------------------------------------------------------- packaged bin

test("the packed tarball exposes a working bin through npm's own resolution", { timeout: 180_000 }, () => {
  const dir = tmp();
  const packed = execSync(`npm pack ${JSON.stringify(PKG)} --pack-destination ${JSON.stringify(dir)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
  const tarball = path.join(dir, packed);
  assert.ok(fs.existsSync(tarball), "npm pack produced no tarball");

  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  execSync(`npm exec --yes --package=${JSON.stringify(tarball)} -- create-studio packed-check`,
    { cwd: out, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  assert.deepEqual(fs.readdirSync(path.join(out, "packed-check")).sort(),
    [".gitignore", "README.md", "packed-check.html", "studio.json", "surfaces.json", "surfaces.row.json"]);
  JSON.parse(fs.readFileSync(path.join(out, "packed-check", "surfaces.row.json"), "utf8"));
});

// ------------------------------------------------------------ suite sanity

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
