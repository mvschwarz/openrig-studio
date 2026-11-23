// install-app refuses a provider whose relative imports leave the copied folder: only that folder is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TOOL = new URL("../tools/install-app.mjs", import.meta.url).pathname;
function tree(t, { escape }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-app-imports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const studio = path.join(root, "studio"),
    app = path.join(root, "src/apps/probe"),
    prov = path.join(root, "src/providers/probe-provider");
  fs.mkdirSync(studio, { recursive: true });
  fs.writeFileSync(
    path.join(studio, "studio.json"),
    JSON.stringify({ apps: [], appsRoot: path.join(studio, "apps") }),
  );
  fs.mkdirSync(path.join(app, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "app.json"),
    JSON.stringify({
      id: "probe",
      name: "Probe",
      surface: { path: "/probe", entry: "app/index.html" },
      vendor: [],
      provider: { package: "probe-provider" },
    }),
  );
  fs.writeFileSync(path.join(app, "app/index.html"), "<p>probe</p>");
  fs.mkdirSync(path.join(prov, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/providers/lib"), { recursive: true });
  fs.writeFileSync(
    path.join(prov, "provider.json"),
    JSON.stringify({
      package: "probe-provider",
      run: { entry: "server.mjs" },
      verbs: ["/api/probe"],
    }),
  );
  fs.writeFileSync(path.join(prov, "lib/own.mjs"), "export const own = 1;\n");
  fs.writeFileSync(path.join(root, "src/providers/lib/shared.mjs"), "export const shared = 1;\n");
  fs.writeFileSync(
    path.join(prov, "server.mjs"),
    escape
      ? 'import { own } from "./lib/own.mjs";\nimport { shared } from "../lib/shared.mjs";\nexport { own, shared };\n'
      : 'import { own } from "./lib/own.mjs";\nexport { own };\n',
  );
  return { studio, app, prov };
}
const run = (x) =>
  spawnSync(process.execPath, [TOOL, x.app, "--provider", x.prov], {
    env: { ...process.env, OPENRIG_STUDIO_DIR: x.studio },
    encoding: "utf8",
    timeout: 60000,
  });

test("a provider importing ../lib/shared.mjs (outside its folder) is refused, naming the import", (t) => {
  const r = run(tree(t, { escape: true })),
    out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0);
  assert.match(
    out,
    /the provider imports files outside its own folder, and only that folder is installed: server\.mjs imports \.\.\/lib\/shared\.mjs/,
  );
  assert.match(out, /enable it there instead of installing it/);
});
test("a provider whose imports stay inside its folder passes that check", (t) => {
  const out = (({ stdout, stderr }) => stdout + stderr)(run(tree(t, { escape: false })));
  assert.match(out, /the provider's imports stay inside its folder/);
  assert.doesNotMatch(out, /imports files outside its own folder/);
});

test("import examples in comments and ordinary strings do not reject a self-contained provider", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(
    path.join(x.prov, "server.mjs"),
    '// import "../lib/shared.mjs";\nconst example = \'import "../lib/shared.mjs"\';\nimport {own} from "./lib/own.mjs";\nexport {own};\n',
  );
  const r = run(x);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(x.studio, "apps/providers/probe-provider/server.mjs")));
});
test("query-qualified local modules are followed before any files are copied", (t) => {
  const x = tree(t, { escape: false }),
    before = fs.readFileSync(path.join(x.studio, "studio.json"));
  fs.writeFileSync(path.join(x.prov, "server.mjs"), 'import "./lib/own.mjs?version=1";\n');
  fs.writeFileSync(
    path.join(x.prov, "lib/own.mjs"),
    'export {shared} from "../../lib/shared.mjs";\n',
  );
  const r = run(x);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /own\.mjs imports \.\.\/\.\.\/lib\/shared\.mjs/);
  assert.equal(fs.existsSync(path.join(x.studio, "apps/providers/probe-provider")), false);
  assert.deepEqual(fs.readFileSync(path.join(x.studio, "studio.json")), before);
});
test("a literal template dynamic import outside the provider is refused", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(path.join(x.prov, "server.mjs"), "await import(`../lib/shared.mjs`);\n");
  const r = run(x);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /imports \.\.\/lib\/shared\.mjs/);
});
test("a CommonJS provider cannot require a file outside its copied folder", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(
    path.join(x.prov, "provider.json"),
    JSON.stringify({
      package: "probe-provider",
      run: { entry: "server.cjs" },
      verbs: ["/api/probe"],
    }),
  );
  fs.writeFileSync(path.join(x.prov, "server.cjs"), 'require("../lib/shared.mjs");\n');
  const r = run(x);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /imports \.\.\/lib\/shared\.mjs/);
});
test("run.entry itself must stay in the copied provider", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(
    path.join(x.prov, "provider.json"),
    JSON.stringify({
      package: "probe-provider",
      run: { entry: "../lib/shared.mjs" },
      verbs: ["/api/probe"],
    }),
  );
  const r = run(x);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /run\.entry.*outside|outside.*run\.entry/);
});
test("a query-qualified self-contained module and dot-prefixed file are installable", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(path.join(x.prov, "..helper.mjs"), "export const q=1;\n");
  fs.writeFileSync(
    path.join(x.prov, "server.mjs"),
    'import "./lib/own.mjs?version=1";\nimport "./..helper.mjs";\n',
  );
  const r = run(x);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("escaped literal paths are resolved before containment is checked", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(path.join(x.prov, "server.mjs"), 'import "\\u002e\\u002e/lib/shared.mjs";\n');
  const r = run(x);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /imports \.\.\/lib\/shared\.mjs/);
});
test("regex examples do not count as module imports", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(
    path.join(x.prov, "server.mjs"),
    'const example = /import "..\\/lib\\/shared.mjs"/;\nimport "./lib/own.mjs";\n',
  );
  const r = run(x);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Three ordinary shapes a first version of the scan misread.
const srv = (x, body) => fs.writeFileSync(path.join(x.prov, "server.mjs"), body);
const outOf = (r) => r.stdout + r.stderr;
test('a computed dynamic import ("./" + name) is a runtime choice, not a refusal', (t) => {
  const x = tree(t, { escape: false });
  srv(
    x,
    'import { own } from "./lib/own.mjs";\nconst name = "lib/own.mjs";\nexport const later = () => import("./" + name);\nexport const req = (n) => import(`./lib/${n}`);\nexport { own };\n',
  );
  const out = outOf(run(x));
  assert.match(out, /the provider's imports stay inside its folder/);
  assert.doesNotMatch(out, /imports files outside its own folder/);
});
test("nested templates keep the scan in step: page text isn't an import, and a real import after them is still read", (t) => {
  const x = tree(t, { escape: false });
  const page =
    'export const page = (xs) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;\nexport const boot = `<script type="module">import { start } from "/assets/boot.js"; start();</script>`;\n';
  srv(x, page + 'import { own } from "./lib/own.mjs";\nexport { own };\n');
  let out = outOf(run(x));
  assert.match(out, /the provider's imports stay inside its folder/, out);
  assert.doesNotMatch(out, /boot\.js/);
  srv(x, page + 'import { shared } from "../lib/shared.mjs";\nexport { shared };\n');
  const r = run(x);
  out = outOf(r);
  assert.notEqual(r.status, 0);
  assert.match(out, /server\.mjs imports \.\.\/lib\/shared\.mjs/);
  assert.doesNotMatch(out, /boot\.js/);
});
test("a / after a number is division, so an outside import after it is still caught", (t) => {
  const x = tree(t, { escape: false });
  srv(
    x,
    'const size = 4096;\nexport const mb = size / 1024 / 1024;\nexport const half = 1.5e3 / 2, hex = 0xff / 3;\nexport const load = async () => await import("../lib/shared.mjs");\n',
  );
  const r = run(x),
    out = outOf(r);
  assert.notEqual(r.status, 0, out);
  assert.match(out, /server\.mjs imports \.\.\/lib\/shared\.mjs/);
});
test("--allow-outside-imports: the owner's say-so installs anyway and says what it skipped", (t) => {
  const x = tree(t, { escape: true });
  const r = spawnSync(
    process.execPath,
    [TOOL, x.app, "--provider", x.prov, "--allow-outside-imports"],
    { env: { ...process.env, OPENRIG_STUDIO_DIR: x.studio }, encoding: "utf8", timeout: 60000 },
  );
  const out = outOf(r);
  assert.match(
    out,
    /installing anyway \(--allow-outside-imports\).*server\.mjs imports \.\.\/lib\/shared\.mjs/,
  );
  assert.doesNotMatch(out, /FAIL  the provider imports files outside/);
  assert.ok(fs.existsSync(path.join(x.studio, "apps/providers/probe-provider/server.mjs")), out);
});
test("without the override, the refusal names it as the way out", (t) => {
  assert.match(outOf(run(tree(t, { escape: true }))), /add --allow-outside-imports/);
});

test("an entry the check can't read (.ts) is reported as not checked, never as 'stays inside'", (t) => {
  const x = tree(t, { escape: false });
  fs.writeFileSync(path.join(x.prov, "server.ts"), 'import { shared } from "../lib/shared.mjs";\n');
  const spec = JSON.parse(fs.readFileSync(path.join(x.prov, "provider.json"), "utf8"));
  spec.run.entry = "server.ts";
  fs.writeFileSync(path.join(x.prov, "provider.json"), JSON.stringify(spec));
  const r = run(x),
    out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /the provider's imports stay inside its folder/, out);
  assert.match(out, /the provider's imports weren't checked in server\.ts/, out);
});
