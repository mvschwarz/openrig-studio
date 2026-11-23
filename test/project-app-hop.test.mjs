// A project app on its own origin signs in at top level once per browser session before the shell frames it. The shell's
// projectAuth decides which rows take that hop; it's run here, taken from the page, against a stand-in location and storage.
// Checked against tools/project-app-server.mjs, whose /_openrig/auth-return sends the person back to this Studio's root
// with the app selected.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = fs.readFileSync(path.join(REPO, "app", "shell.html"), "utf8");

function projectAuthFrom(studio, stored = new Map()) {
  const start = SHELL.indexOf("function projectAuth(s) {");
  assert.ok(start > 0, "the shell declares projectAuth");
  const end = SHELL.indexOf("\n  }\n", start) + 4;
  const sessionStorage = {
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => stored.set(k, v),
  };
  return new Function(
    "location",
    "sessionStorage",
    `${SHELL.slice(start, end)}; return projectAuth;`,
  )(new URL(studio), sessionStorage);
}

test("only an owner-declared project app on another origin takes the hop, once per session", () => {
  const stored = new Map();
  const auth = projectAuthFrom("https://studio.example.com/?s=notes", stored);
  const hop = auth({ id: "notes", url: "https://apps.example.com/project-apps/notes/" });
  assert.equal(hop.url.href, "https://apps.example.com/_openrig/auth-return");
  assert.equal(hop.key, "openrig-project-auth-once-v1:https://apps.example.com:notes");
  stored.set(hop.key, "1");
  assert.equal(
    auth({ id: "notes", url: "https://apps.example.com/project-apps/notes/" }),
    null,
    "once per browser session",
  );
  // Same origin, another path, a mismatched id, plain http off loopback: no hop.
  assert.equal(auth({ id: "notes", url: "https://studio.example.com/project-apps/notes/" }), null);
  assert.equal(auth({ id: "notes", url: "https://apps.example.com/other/notes/" }), null);
  assert.equal(auth({ id: "notes", url: "https://apps.example.com/project-apps/other/" }), null);
  assert.equal(auth({ id: "notes", url: "http://apps.example.com/project-apps/notes/" }), null);
  assert.equal(auth({ id: "Notes!", url: "https://apps.example.com/project-apps/Notes!/" }), null);
  // Loopback http is a local Studio's own project app.
  assert.ok(
    projectAuthFrom("http://127.0.0.1:8890/")({
      id: "notes",
      url: "http://localhost:9000/project-apps/notes/",
    })?.url,
  );
  assert.deepEqual(
    auth({ id: "notes", url: "http://[" }),
    { blocked: true },
    "an unparseable URL blocks rather than guessing",
  );
});

test("the hop saves a chat draft first, and never leaves while one is unsaved", () => {
  const prep = SHELL.slice(
    SHELL.indexOf("function prepareProject("),
    SHELL.indexOf("function activate("),
  );
  assert.match(prep, /appChat && typeof appChat\.checkpoint !== "function"\) throw/);
  assert.match(prep, /if \(appChat\?\.checkpoint\(\)\) throw Error\("draft not saved"\)/);
  assert.ok(
    prep.indexOf("checkpoint()") < prep.indexOf("location.assign"),
    "the draft is saved before leaving",
  );
  assert.match(prep, /auth\.url\.searchParams\.set\("studio", location\.href\)/);
  assert.match(
    SHELL,
    /if \(auth\) \{\s*for \(const f of frames\.values\(\)\) f\.classList\.add\("hidden"\);\s*prepareProject\(s, auth, hop\);/,
  );
});
