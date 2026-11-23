// The shell says what happened to the app list: never an empty rail that looks like an empty workspace.
//
// STRUCTURAL (no browser here). Checked live at 390x844: with /surfaces.json aborted the stage shows "Your apps couldn't
// load / Your workspace didn't answer just now. Try again in a moment. / Try again" and the rail says "app list: unanswered",
// with no sideways scroll; with the list served normally there's no card and the rail keeps "manifest ok".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");

test("each outcome of the app-list read is its own card: refused, an HTTP error, unreadable, unanswered, all unusable, empty", () => {
  assert.doesNotMatch(
    shell,
    /try \{ reg = await \(await fetch\("\/surfaces\.json"[^\n]*\} catch \{\}/,
    "the read no longer swallows a failure",
  );
  assert.match(shell, /kind: r\.status === 401 \|\| r\.status === 403 \? "refused" : "http"/);
  assert.match(
    shell,
    /manifestProblem = \{ kind: e instanceof SyntaxError \? "unreadable" : "unanswered" \}/,
  );
  for (const words of [
    "Your sign-in wasn't accepted, or it has ended. Sign in again, then try again.",
    "Your app list came back in a form this page can't read. Try again in a moment.",
    "Your workspace didn't answer just now. Try again in a moment.",
    "None of the apps on your list could be shown. Try again in a moment.",
    "No apps are set up in this workspace yet.",
  ])
    assert.ok(shell.includes(words), words);
  assert.match(shell, /b\.textContent = "Try again"; b\.onclick = \(\) => location\.reload\(\)/);
  assert.match(
    shell,
    /couldn't be shown`/,
    "a partly unusable list says how many rows were left out",
  );
});

test("a hosted Studio's card adds who to ask and a way to sign in again; the desk keeps the code on the rail", () => {
  assert.match(
    shell,
    /if \(place\?\.profile === "hosted"\) draw\(true, place\.account \?\? null\)/,
  );
  assert.match(shell, /a\.textContent = "Sign in again"/);
  assert.match(shell, /contact the person who set up your workspace/);
  assert.match(shell, /health\.textContent = `app list: \$\{manifestProblem\.kind\}/);
});

test("the stage's waiting text is about the person's apps, not the manifest", () => {
  assert.match(shell, /<div id="empty">Loading your apps…<\/div>/);
});
