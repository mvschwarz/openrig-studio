// The shared file viewer.
//
//   node --test 'test/*.test.mjs'
//
// STRUCTURAL by necessity — this repo has no browser dependency. Every claim below
// was driven in a live shell against one file of each kind plus a hostile one:
//
//   markdown : h1/strong/code/2 list items rendered, link href preserved
//   text     : <pre>, content present
//   html     : <iframe sandbox="" srcdoc>, NOT injected into the app DOM, the file's
//              <script> did not run in the app, app title unchanged, frame origin opaque
//   image    : <img> with naturalWidth > 0
//   missing  : error shown, and it says "not an empty file"
//   hostile  : javascript: link stripped to text, raw <img onerror> and <script> not
//              rendered as elements, no XSS global fired, markup shown as literal text
//   chain    : 5 entries, icon + filename, zero thumbnails
//
// What is committed here is the MECHANISM that produces those, so removing the
// sandbox or the escape-before-format order fails without needing a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = () => fs.readFileSync(path.join(REPO, "app", "file-viewer.js"), "utf8");

// CODE ONLY. This file is heavily commented on purpose, and a keyword assertion
// over raw source cannot tell a comment EXPLAINING a property from code VIOLATING
// it — two of these checks failed on their own explanatory prose the first time
// they ran. Strip comments and assert on what executes.
const code = () => src()
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const css = () => fs.readFileSync(path.join(REPO, "app", "file-viewer.css"), "utf8");

test("HTML is sandboxed, never injected into the app's DOM", () => {
  // An HTML proof artifact is a document from somewhere else. innerHTML would give
  // it this app's origin and this app's verbs.
  const s = code();
  const html = s.match(/case "html":([\s\S]*?)case "text":/);
  assert.ok(html, "the html branch is gone");
  assert.match(html[1], /<iframe[^>]*\bsandbox\b/,
    "html is no longer rendered in a sandboxed iframe");
  assert.match(html[1], /srcdoc=/, "html is not passed via srcdoc");
  assert.doesNotMatch(html[1], /innerHTML/, "the html branch reaches for innerHTML");
});

test("markdown ESCAPES FIRST, then formats — the order is the safety property", () => {
  // Formatting first and escaping after emits whatever HTML the file contained.
  const s = src();
  const md = s.match(/function markdown\(src\) \{([\s\S]*?)\n\}/);
  assert.ok(md, "the markdown renderer is gone");
  assert.match(md[1], /esc\(src\)/, "markdown does not escape its input before formatting");
  const escIdx = md[1].indexOf("esc(src)");
  const fmtIdx = md[1].search(/replace\(\/`/);
  assert.ok(escIdx >= 0 && (fmtIdx < 0 || escIdx < fmtIdx),
    "formatting happens before escaping — the file's own markup would survive");
});

test("markdown link hrefs are scheme-limited", () => {
  // `javascript:` in a markdown link is the obvious hole, and a proof artifact is
  // exactly the kind of file that arrives from elsewhere.
  const s = src();
  assert.match(s, /\^\(https\?:\|\\\/\|#\)/,
    "the link-href scheme allowlist is gone — javascript: URLs would render as links");
});

test("a chain entry is ICON + FILENAME, never a thumbnail", () => {
  // A wall of thumbnails turns an ordered story into a contact sheet. The PRD is
  // explicit and the reason is in the shape, so it is pinned.
  const s = src();
  const link = s.match(/export function fileLink\([\s\S]*?\n\}/);
  assert.ok(link, "fileLink is gone");
  assert.match(link[0], /fv-link-icon/);
  assert.match(link[0], /fv-link-name/);
  assert.doesNotMatch(link[0], /<img/, "chain entries render an image — they are thumbnails again");
});

test("kind comes from the RUNTIME, not from the filename", () => {
  // The verb already decided. Re-deciding by extension is two places computing one
  // property, and they disagree first on the files that matter — a .txt holding a
  // terminal capture, a .md that is really a log.
  const s = src();
  assert.match(s, /doc\.kind/, "the viewer no longer switches on the runtime's kind");
  assert.doesNotMatch(s, /\.split\("\."\)\.pop\(\)|extname/,
    "the viewer derives kind from the filename somewhere");
});

test("an unreadable file SAYS so — a failure must not borrow an empty file's look", () => {
  const s = src();
  assert.match(s, /class="fv-error"/, "there is no error rendering path");
  assert.match(s, /not an empty file/,
    "the error does not distinguish unreachable from empty, which is the wrong conclusion to invite");
  assert.match(css(), /\.fv-error\s*\{/, "the error state has no styling, so it reads as body text");
});

test("closing empties the body, so media stops", () => {
  // A video that keeps playing behind a closed modal is the shape of a viewer that
  // looks closed and is not.
  const s = src();
  const close = s.match(/export function closeViewer\(\)[\s\S]*?\n\}/);
  assert.ok(close, "closeViewer is gone");
  assert.match(close[0], /innerHTML = ""/, "closing leaves the body mounted; media keeps playing");
});

test("positive control: these checks can fail", () => {
  const s = code();
  const unsandboxed = s.replace(/<iframe class="fv-frame" sandbox/, '<iframe class="fv-frame"');
  const html = unsandboxed.match(/case "html":([\s\S]*?)case "text":/);
  assert.doesNotMatch(html[1], /\bsandbox\b/,
    "the sandbox attribute could not be removed, so that assertion proves nothing");

  const unescaped = s.replace(/const lines = esc\(src\)\.split/, "const lines = String(src).split");
  const md = unescaped.match(/function markdown\(src\) \{([\s\S]*?)\n\}/);
  assert.doesNotMatch(md[1], /esc\(src\)/,
    "the escape could not be removed, so the ordering assertion is untested");
});
