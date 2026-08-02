#!/usr/bin/env node
// create-studio — scaffold an openrig studio surface project.
//
// The intended public front door is:
//
//     npm create @openrig/studio <name>
//
// which npm resolves to the package @openrig/create-studio and runs this bin.
// That command is NOT AVAILABLE YET: this package is unpublished (private),
// and its final name is a deferred decision. Until it is published, run the
// shipped entrypoint directly — see --help. Publishing is a metadata step,
// not a rewrite: nothing below changes when it happens.
//
// Order of operations is the whole design: ADMIT everything first, RENDER into
// memory, then write once. Nothing reaches the filesystem until every check has
// passed, and generation stages into a sibling directory that is renamed into
// place atomically. A failed run leaves no partial project.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { admitName, admitDestination } from "./lib/admission.mjs";
import { emitProject } from "./lib/emit.mjs";
import { escapeHtml, toJsLiteral, assertMarkdownSafe, render } from "./lib/render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(HERE, "templates");

const CONTRACT_VERSION = "0.1";
const VERSION = "0.1.0";

const USAGE = `create-studio — scaffold an openrig studio surface (contract v${CONTRACT_VERSION})

USAGE
  create-studio <name> [--dir <parent>] [--glyph <char>] [--hint <text>]

  <name>          project directory and surface id: lowercase letters, digits
                  and dashes (e.g. my-surface)
  --dir <parent>  where to create it (default: the current directory)
  --glyph <char>  one-character rail glyph (default: ◆)
  --hint <text>   one-line rail tooltip
  --help, --version

RUNNING IT TODAY
  node create-studio/index.mjs my-surface

  The public form 'npm create @openrig/studio my-surface' resolves to the
  package @openrig/create-studio. That package is NOT PUBLISHED YET, so the
  command does not work today. Use the direct invocation above, or exercise the
  real npm path against a local pack:

    npm pack ./create-studio
    npm exec --package=./openrig-create-studio-${VERSION}.tgz -- create-studio my-surface
`;

function fail(message) {
  console.error(`create-studio: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { name: undefined, dir: process.cwd(), glyph: "◆", hint: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--version" || a === "-v") return { version: true };
    if (a === "--dir" || a === "--glyph" || a === "--hint") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${a} needs a value`);
      }
      if (a === "--dir") opts.dir = value;
      if (a === "--glyph") opts.glyph = value;
      if (a === "--hint") opts.hint = value;
      i += 1;
      continue;
    }
    if (a.startsWith("-")) fail(`unknown option ${a} — see --help`);
    rest.push(a);
  }
  if (rest.length > 1) fail(`expected one project name, got ${rest.length}: ${rest.join(" ")}`);
  opts.name = rest[0];
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return; }
  if (opts.version) { process.stdout.write(`${VERSION} (contract v${CONTRACT_VERSION})\n`); return; }

  // ---- admission: everything that can say no happens before any write ------
  const named = admitName(opts.name);
  if (!named.ok) fail(named.error);

  if (opts.glyph !== undefined && [...opts.glyph].length !== 1) {
    fail(`--glyph must be exactly one character, got ${JSON.stringify(opts.glyph)}`);
  }

  const placed = admitDestination(named.name, opts.dir);
  if (!placed.ok) fail(placed.error);

  // ---- render: build every file in memory ---------------------------------
  const id = named.name;
  const label = id.replace(/-/g, " ").toUpperCase();
  const hint = opts.hint ?? `${label} — starter surface`;

  const vars = {
    ID: id,
    NAME: named.name,
    LABEL: label,
    GLYPH: opts.glyph,
    HINT: hint,
    CONTRACT_VERSION,
  };

  const read = (file) => fs.readFileSync(path.join(TEMPLATES, file), "utf8");

  // JSON is built STRUCTURALLY and serialized — never string-substituted into a
  // JSON literal. Templating JSON as text is what let `--hint 'say "hello"'` and
  // `--glyph '"'` emit a file that JSON.parse rejects while the CLI exited 0.
  // JSON.stringify also escapes newlines and backslashes, which is what keeps a
  // hint from breaking out of the fenced code block in the emitted README.
  const row = { id, name: label, glyph: opts.glyph, path: `/surfaces/${id}.html`, hint };
  const rowPretty = JSON.stringify(row, null, 2);
  const rowJson = rowPretty + "\n";
  // The emitted README shows the row inline so it can be pasted without opening
  // a second file. The README places the token inside a numbered-list code
  // fence indented by three spaces, and that indent only applies to the FIRST
  // line — so every subsequent line must carry it explicitly or the block comes
  // out ragged (opening brace at 3, closing brace at 2). Keep README_INDENT in
  // step with the template's indentation.
  const README_INDENT = "   ";
  const rowInline = rowPretty
    .split("\n")
    .map((line, i) => (i === 0 ? line : README_INDENT + line))
    .join("\n");

  // Markdown is not escaped by design; this asserts the invariant that makes
  // that safe. See lib/render.mjs for why escaping code spans would be wrong.
  assertMarkdownSafe({ ID: id, LABEL: label });

  const files = {
    // HTML context: escape every interpolated value. The one JS-string context
    // (`const TARGET_CONTRACT = ...`) takes a JSON-encoded *_JS token instead —
    // HTML-escaping there would emit a literal &quot; into executable code.
    // RUNNABLE ON FIRST RUN. This used to emit `surface.html` plus a bare row
    // and ask the developer to rename the file and hand-assemble a
    // surfaces.json. Two manual steps between "scaffolded" and "works" is two
    // places to get it wrong, on the first artifact a new developer ever sees.
    // The row is still emitted, because README.md explains its shape and a
    // reader should be able to see the thing being explained.
    [`${id}.html`]: render(
      read("surface.html"),
      { ...vars, CONTRACT_VERSION_JS: toJsLiteral(CONTRACT_VERSION) },
      (value, key) => (key.endsWith("_JS") ? value : escapeHtml(value))
    ),
    "surfaces.json": JSON.stringify({ surfaces: [JSON.parse(rowJson)] }, null, 2) + "\n",
    "studio.json": JSON.stringify({
      _note: "Boot with: OPENRIG_STUDIO_DIR=. node <sdk>/tools/studio.mjs",
      port: 8890, apps: [], appsRoot: "./apps",
    }, null, 2) + "\n",
    "surfaces.row.json": rowJson,
    "README.md": render(read("README.md"), { ...vars, ROW_INLINE: rowInline }),
  };

  // ---- emit: stage, then one atomic rename --------------------------------
  let result;
  try {
    result = emitProject(placed.dest, files);
  } catch (error) {
    fail(`generation failed, nothing was written: ${error.message}`);
  }

  // Show the shortest path that is still unambiguous: a relative path only
  // when the project is actually under the cwd, otherwise the absolute one.
  // (A "../../../.." chain is technically correct and useless to read.)
  const relative = path.relative(process.cwd(), result.dest);
  const rel = !relative ? "." : relative.startsWith("..") ? result.dest : relative;
  process.stdout.write(
    `\ncreated ${rel}/  (contract v${CONTRACT_VERSION})\n` +
    result.files.map((f) => `  ${f}\n`).join("") +
    // These next steps deliberately keep the surface in the developer's OWN
    // repo. The older form told them to cp into <studio>/app/surfaces/, which in
    // a real install is node_modules — wiped by npm ci and carried by any copy
    // of the tree. The scaffolder is the first artifact a new developer reads;
    // it should not teach the path the SDK exists to remove.
    `\nnext:\n` +
    `  node <sdk>/app/serve-studio.mjs --surfaces ${rel}   then open http://127.0.0.1:8890/\n` +
    `  or, to run providers and apps too:\n` +
    `    OPENRIG_STUDIO_DIR=${rel} node <sdk>/tools/studio.mjs\n\n` +
    `It runs as-is — ${id}.html and surfaces.json are already wired.\n` +
    `Your surface stays in YOUR repo — nothing is copied into the studio package.\n` +
    `${rel}/README.md has the details and points at the contract docs.\n`
  );
}

main();
