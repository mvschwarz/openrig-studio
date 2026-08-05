// The shell's module-level STATE is declared in one block, above anything that runs.
//
//   node --test 'test/*.test.mjs'
//
// FOUR TEMPORAL DEAD ZONES HAVE SHIPPED FROM app/shell.html, three of them in one
// afternoon, and every one had the same shape: a collection declared next to the
// code that FIRES it — which is where it reads most naturally — while a function
// defined earlier READS it during boot. activate() runs while the shell starts.
//
// WHAT MAKES THE CLASS WORTH A TEST RATHER THAN CARE IS HOW IT PRESENTS. It does
// not look like a crash. The rail renders, the tabs render, the page is plainly
// alive — and the header stays blank, because activate() threw halfway through.
// Three of the four were found by something ELSE being missing. None was found by
// looking at the page, and no assertion in this suite could see any of them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS CHECKS, AND WHY IT IS NARROW ON PURPOSE.
//
// The first version of this test asked a bigger question — "is any module binding
// read above its declaration?" — by scanning for the identifier. It reported three
// offenders on correct code: an object PROPERTY KEY (`{ surfaces: [] }`), a
// substring inside a STRING (`"hide-agents"`), and a property ACCESS
// (`e.data.seat`). Text matching cannot tell an identifier from a property, which
// is this repository's own standing rule, and a guard that fires on correct code
// trains people to reword correct code until it stops.
//
// So this asks a smaller question it can answer STRUCTURALLY: every module-level
// COLLECTION — the `new Map()` / `new Set()` that hold shell state — is declared
// in the state block at the top. All four faults were exactly that: two Sets and
// a Map, each declared beside its consumer.
//
// NOT CLAIMED: this does not prove the absence of a TDZ. A scalar `let` read early
// still slips through, and the genuine check is a browser loading the page and
// failing when the shell does not finish starting — which needs a dependency this
// SDK does not have and will not grow. This is the honest substitute; its limits
// are written here rather than assumed.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = path.join(REPO, "app", "shell.html");
const MARKER = "SHELL STATE. EVERY MODULE-LEVEL";

function shellScript() {
  const html = fs.readFileSync(SHELL, "utf8");
  const open = html.indexOf("<script>");
  const close = html.lastIndexOf("</script>");
  assert.ok(open !== -1 && close > open, "app/shell.html no longer has an inline script to check");
  return html.slice(open + "<script>".length, close);
}

// Module-level collections: declared at the IIFE's own two-space indent.
const collections = (src) => src.split("\n").flatMap((line, i) => {
  const m = /^ {2}const\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(Map|Set)\s*\(/.exec(line);
  return m ? [{ name: m[1], kind: m[2], line: i + 1 }] : [];
});

test("positive control: the script, the state block, and the collections are all found", () => {
  // Without this the file passes by parsing nothing — the failure it exists to
  // prevent, one level up.
  const src = shellScript();
  assert.ok(src.length > 2000, `extracted only ${src.length} chars of shell script`);
  assert.ok(src.includes(MARKER), "the state block's header comment is gone; this test cannot locate it");
  const found = collections(src);
  assert.ok(found.length >= 3, `found only ${found.length} module-level collections`);
  for (const expect of ["surfaceListeners", "markupListeners", "declaredHeaders"]) {
    assert.ok(found.some((c) => c.name === expect),
      `${expect} is no longer a module-level collection — this test is checking the wrong thing`);
  }
});

test("every module-level collection is declared in the state block at the top", () => {
  const src = shellScript();
  const lines = src.split("\n");
  const blockLine = lines.findIndex((l) => l.includes(MARKER)) + 1;

  // The block ends at the first line of real code after it that is not a
  // declaration or a comment — in practice, the contract-meta fetch.
  let blockEnd = blockLine;
  for (let i = blockLine; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("//")) continue;
    if (/^const\s+[A-Za-z_$][\w$]*\s*=\s*new\s+(Map|Set)\s*\(/.test(t)) { blockEnd = i + 1; continue; }
    break;
  }

  const stragglers = collections(src)
    .filter((c) => c.line > blockEnd)
    .map((c) => `${c.name} (${c.kind}) declared at line ${c.line}, outside the state block which ends at ${blockEnd}`);

  assert.deepEqual(stragglers, [],
    "a module-level collection in app/shell.html is declared outside the state block. " +
    "Four temporal dead zones have shipped from exactly this — a collection declared beside the " +
    "code that fires it, read by activate() during boot, producing a live-looking page with a " +
    "blank header rather than an error:\n  " + stragglers.join("\n  "));
});

test("positive control: this suite is capable of failing", () => {
  assert.throws(() => assert.equal(1, 2));
});
