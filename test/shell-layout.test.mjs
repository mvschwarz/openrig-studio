// The rail is full height and the header starts beside it.
//
//   node --test 'test/*.test.mjs'
//
// Founder-directed: the header must not run the full width, the rail goes to the
// TOP of the page, and the collapse control belongs on the rail rather than in the
// header — a control belongs to the thing it acts on, and among MARKUP and AGENTS
// it read as a studio-level control when it is only ever about the launcher.
//
// STRUCTURAL, and it says so: this repo has no browser dependency. The layout was
// measured in a live shell at both states —
//   expanded  : rail 212x720 (full viewport height), #topbar.left = 212
//   collapsed : body.rail-collapsed, rail 52x720, #topbar.left = 52, glyphs intact
// — and an agent mark anchored to an element in the surface landed with a gap of
// 0x0 after #stage moved 212px right, which is the thing the restructure could
// most plausibly have broken.
//
// What is committed here is the SHAPE that produces that: reverting the nesting,
// or moving the toggle back into the header, fails without needing a browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = () => fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");

test("#app is a ROW and the rail is its direct child", () => {
  const s = shell();
  assert.match(s, /#app \{[^}]*flex-direction: row/,
    "#app is not a row — the rail cannot be full height beside the header");
  assert.match(s, /<div id="app">\s*\n\s*<nav id="rail">/,
    "the rail is not the first child of #app, so it does not start at the top of the page");
  assert.match(s, /#maincol \{[^}]*flex-direction: column/,
    "#maincol is missing or is not a column");
});

test("the header lives inside #maincol, not beside the rail's parent", () => {
  const s = shell();
  const main = s.match(/<div id="maincol">([\s\S]*?)<div id="shellframes">/);
  assert.ok(main, "#maincol does not open before #shellframes");
  assert.match(main[1], /<header id="topbar">/,
    "#topbar is not inside #maincol — it would span the full width again");
});

test("the collapse toggle is ON THE RAIL", () => {
  const s = shell();
  const head = s.match(/<div id="rail-head">([\s\S]*?)<\/div>/);
  assert.ok(head, "#rail-head is no longer a block element with children");
  assert.match(head[1], /id="railToggle"/,
    "the collapse control is not in the rail head — a control belongs to the thing it acts on");
  const topbar = s.match(/<header id="topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbar, "cannot find #topbar");
  assert.doesNotMatch(topbar[1], /id="railToggle"/,
    "the collapse control is back in the header");
});

test("the rail's text is wrapped so collapsing hides it explicitly", () => {
  const s = shell();
  assert.match(s, /<span class="headtext">/,
    "the rail head text is not wrapped, so collapsing has to hide it by inherited font-size: 0");
  assert.match(s, /body\.rail-collapsed #rail-head \.headtext \{[^}]*display: none/,
    "collapsing does not hide the head text");
});

test("ONE rule per selector — the merge studio-impl offered and I took", () => {
  // Their patch added a second #rail-head block beside the original and offered to
  // merge. Two rules for one selector is two places computing one property, which
  // this repo has already paid for three times; they are merged.
  const s = shell();
  const count = (sel) =>
    (s.match(new RegExp("^\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{", "gm")) || []).length;
  assert.equal(count("#rail-head"), 1, "#rail-head is declared more than once");
  assert.equal(count("body.rail-collapsed #rail-head"), 1, "the collapsed rail head is declared more than once");
  assert.equal(count("#railToggle"), 1, "#railToggle is declared more than once");
});

test("the overlay still mounts on #stage, so annotations are unaffected", () => {
  // The restructure moves #app, #maincol and the rail. It must NOT reach the
  // overlay, which a shell feature attaches to — verified live (mark landed 0x0
  // off its element after #stage moved 212px), pinned structurally here.
  const s = shell();
  assert.match(s, /document\.getElementById\("stage"\)\.appendChild\(overlayHost\)/,
    "the overlay no longer mounts on #stage — the outer restructure has reached a shell feature");
});

test("positive control: these checks can fail", () => {
  const s = shell();
  const reverted = s.replace(/#app \{[^}]*flex-direction: row/, "#app { display: flex; flex-direction: column");
  assert.doesNotMatch(reverted, /#app \{[^}]*flex-direction: row/,
    "the row could not be reverted, so the first assertion proves nothing");
  const moved = s.replace(/<div id="rail-head">[\s\S]*?<\/div>/, '<div id="rail-head">STUDIO</div>');
  const head = moved.match(/<div id="rail-head">([\s\S]*?)<\/div>/);
  assert.doesNotMatch(head[1], /railToggle/,
    "the toggle could not be removed from the head, so that assertion is untested");
});
