#!/usr/bin/env node
// Fails when comments carry history instead of reasons: ticket ids, dated
// or time stamps, TODOs signed with a name. Comments should say why the code is the
// way it is; that history belongs in commit messages and the tracker.
//
//   node scripts/check-comments.mjs                    (exit 1 and a list when it finds any)
//   node scripts/check-comments.mjs --private <file>   (also apply a private list)
//
// The patterns here are generic. A team can add its own (people, team names,
// internal ids) from a JSON file kept outside the repository, passed with
// --private or the COMMENT_CHECK_PRIVATE environment variable:
//   [{ "what": "person reference", "pattern": "\\bAlex\\b", "flags": "", "scope": "anywhere" | "comments" }]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Generic rules, checked inside comments only (test data and code may hold
// real dates and identifiers). Ticket ids look like ABC-123; the lookahead
// leaves encodings, standards and terminal sequences (UTF-8, SHA-256, ISO-8601, OSC-52) alone.
export const PUBLIC_RULES = Object.freeze([
  {
    what: "ticket id",
    re: /\b(?!(?:UTF|SHA|ISO|RFC|ES|TLS|HTTP|CVE|OSC|CSI|DCS)-)[A-Z][A-Z0-9]{1,9}-\d{2,}\b/,
    scope: "comments",
  },
  { what: "dated stamp", re: /\b20\d\d-[01]\d-[0-3]\d\b/, scope: "comments" },
  // A time of day in UTC ("12:34Z", or "12:3xZ" for roughly then) says when someone decided something, which is
  // history. A full HH:MM:SSZ time, as in an example timestamp, is left alone.
  { what: "time stamp", re: /(?<![:\d])\b[0-2]\d:[0-5][\dx]Z\b/, scope: "comments" },
  { what: "signed TODO", re: /\b(?:TODO|FIXME|XXX)\([^)]*\)/, scope: "comments" },
]);

// A private list from a JSON file: each entry becomes a rule. Throws with a
// plain reason when the file is not a list of { what, pattern } entries.
export function loadPrivateRules(file) {
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${file}: expected a JSON list`);
  return list.map((e, i) => {
    if (!e || typeof e.what !== "string" || typeof e.pattern !== "string")
      throw new Error(`${file}: entry ${i} needs "what" and "pattern"`);
    const scope = e.scope === "comments" ? "comments" : "anywhere";
    return {
      what: e.what,
      re: new RegExp(e.pattern, typeof e.flags === "string" ? e.flags.replace(/g/g, "") : ""),
      scope,
    };
  });
}

const CODE = /\.(?:mjs|cjs|js|html|css|sh|py)$/;
const HASH_COMMENTS = /\.(?:sh|py)$/;

// The comment text on each line, for the comment styles these files use. A
// heuristic, not a parser: `//` after a colon is taken to be part of a URL.
export function commentText(text, file) {
  const out = [];
  let block = null; // the closing token of an open block comment
  for (const line of text.split("\n")) {
    let rest = line;
    let found = "";
    for (;;) {
      if (block) {
        const end = rest.indexOf(block);
        if (end === -1) {
          found += " " + rest;
          break;
        }
        found += " " + rest.slice(0, end);
        rest = rest.slice(end + block.length);
        block = null;
        continue;
      }
      if (HASH_COMMENTS.test(file)) {
        const m = /(?:^|\s)#(?!!)(.*)$/.exec(rest);
        if (m) found += " " + m[1];
        break;
      }
      const open = /\/\*|<!--/.exec(rest);
      const lineComment = /(?:^|[^:\\"'`])\/\/(.*)$/.exec(rest);
      if (lineComment && (!open || lineComment.index < open.index)) {
        found += " " + lineComment[1];
        break;
      }
      if (!open) break;
      block = open[0] === "/*" ? "*/" : "-->";
      rest = rest.slice(open.index + open[0].length);
    }
    out.push(found);
  }
  return out;
}

export function findViolations(text, file, rules = PUBLIC_RULES) {
  const hits = [];
  const comments = commentText(text, file);
  text.split("\n").forEach((line, i) => {
    for (const { what, re, scope } of rules) {
      const m = re.exec(scope === "comments" ? comments[i] : line);
      if (m) hits.push({ line: i + 1, what, match: m[0] });
    }
  });
  return hits;
}

function trackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    walk("");
    return files;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const root = path.resolve(path.dirname(self), "..");
  const flag = process.argv.indexOf("--private");
  const privateFile = flag !== -1 ? process.argv[flag + 1] : process.env.COMMENT_CHECK_PRIVATE;
  let rules = PUBLIC_RULES;
  if (privateFile) {
    try {
      rules = [...PUBLIC_RULES, ...loadPrivateRules(privateFile)];
    } catch (e) {
      console.error(`comment check: ${e.message}`);
      process.exit(2);
    }
  }
  const files = trackedFiles(root).filter(
    (f) => CODE.test(f) && path.resolve(root, f) !== self && fs.existsSync(path.join(root, f)),
  );
  let count = 0;
  for (const f of files) {
    for (const h of findViolations(fs.readFileSync(path.join(root, f), "utf8"), f, rules)) {
      console.log(`${f}:${h.line}: ${h.what}: ${h.match}`);
      count++;
    }
  }
  if (count) {
    console.error(
      `\n${count} internal reference(s). Rewrite each comment to say why the code is this way, or delete it if it is only history.`,
    );
    process.exit(1);
  }
  console.log(`comment check: ${files.length} files clean (${rules.length} rules)`);
}
