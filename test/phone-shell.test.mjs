// The shell on a phone: never wider than the screen, and the rail is a drawer over the page under 600px.
//
// STRUCTURAL, and it says so (this repo has no browser dependency). Measured in a live shell at 390x844: with the agents
// panel open the page was 452px wide before (a fixed 400px minimum beside the main column) and 390 after; the drawer opened
// from the menu button with focus on the open surface's item, and Escape, the scrim and choosing a surface each closed it,
// focus back on the menu button. At 650 and 1440 the menu button is hidden and the rail is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");

test("the agents panel is never wider than its column, and a long rig name may shrink", () => {
  assert.match(shell, /#agents \{[^}]*min-width: min\(400px, 100%\)/);
  assert.doesNotMatch(shell, /#agents \{[^}]*min-width: 400px/);
  assert.match(shell, /#chatRigSel \{[^}]*min-width: 0;/);
});

test("under 600px the rail is a drawer: a menu button opens it, and the scrim, Escape and a chosen surface close it", () => {
  assert.match(
    shell,
    /<button type="button" id="navMenu" aria-label="Open menu" aria-expanded="false" aria-controls="rail">/,
  );
  assert.match(shell, /<div id="navScrim"><\/div>/);
  assert.match(shell, /#navMenu, #navScrim \{ display: none; \}/, "hidden from 600px up");
  assert.match(
    shell,
    /@media \(max-width: 599\.98px\) \{[\s\S]*?body\.navDrawer #rail \{ transform: none; visibility: visible;/,
  );
  assert.match(shell, /navMenu\.onclick = \(\) => drawer\(/);
  assert.match(shell, /getElementById\("navScrim"\)\.onclick = \(\) => drawer\(false\)/);
  assert.match(
    shell,
    /e\.key === "Escape" && document\.body\.classList\.contains\("navDrawer"\)\) drawer\(false\)/,
  );
  assert.match(shell, /closest\("\.tab"\)\?\.dataset\.id\) drawer\(false\)/);
  assert.match(
    shell,
    /else if \(inside\) navMenu\.focus\(\)/,
    "focus never stays on a hidden control",
  );
});
