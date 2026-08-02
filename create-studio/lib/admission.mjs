// Admission — every check that can reject a run happens HERE, before the
// emitter touches the filesystem. That ordering is the contract: a rejected
// invocation writes nothing at all, so there is no partial project to clean up.
//
// Kept deliberately boring and dependency-free. Each rejection names what was
// wrong AND what to do instead, per the honest-failure stance in
// contract/contract-meta.md.

import fs from "node:fs";
import path from "node:path";

// A project name is also a directory name and a surface id, so it has to be
// safe as all three: one path segment, no traversal, no shell/OS surprises.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME = 64;

// "." and ".." are caught by the leading-dot rule too; listed anyway so the
// reserved set reads as a complete statement of intent rather than a leftover.
const RESERVED = new Set([
  ".", "..", "node_modules",
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const reject = (error) => ({ ok: false, error });

export function admitName(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return reject('a project name is required — try: create-studio my-surface');
  }
  const name = String(raw);
  if (!name.trim()) {
    return reject('project name is blank — try: create-studio my-surface');
  }
  if (name !== name.trim()) {
    return reject(`project name has surrounding whitespace: ${JSON.stringify(name)} — remove it`);
  }
  if (name.startsWith("~")) {
    return reject(`project name must not start with "~": ${name} — pass a bare name and use --dir for the parent directory`);
  }
  if (path.isAbsolute(name)) {
    return reject(`project name must not be an absolute path: ${name} — pass a bare name and use --dir for the parent directory`);
  }
  if (name.includes("/") || name.includes("\\")) {
    return reject(`project name must be a single path segment (no "/" or "\\"): ${name} — use --dir to choose the parent directory`);
  }
  if (name.startsWith(".")) {
    return reject(`project name must not start with "." : ${name} — dotted names hide the project and ".." would escape the parent`);
  }
  if (name.length > MAX_NAME) {
    return reject(`project name is ${name.length} characters; the limit is ${MAX_NAME}`);
  }
  if (RESERVED.has(name.toLowerCase())) {
    return reject(`project name "${name}" is reserved — choose another`);
  }
  if (!NAME_RE.test(name)) {
    return reject(`project name must be lowercase letters, digits and dashes, starting and ending alphanumeric: ${name} (e.g. my-surface)`);
  }
  return { ok: true, name };
}

// Destination admission assumes the name already passed admitName(), so `name`
// is a single safe segment. The containment assertion below is defence in
// depth: it would catch a future caller that skipped that ordering.
export function admitDestination(name, parentRaw) {
  const parent = path.resolve(parentRaw);
  if (!fs.existsSync(parent)) {
    return reject(`destination parent does not exist: ${parent}`);
  }
  if (!fs.statSync(parent).isDirectory()) {
    return reject(`destination parent is not a directory: ${parent}`);
  }

  const dest = path.join(parent, name);
  if (path.dirname(dest) !== parent) {
    return reject(`refusing to write outside the parent directory: ${dest} is not directly inside ${parent}`);
  }

  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest);
    if (!stat.isDirectory()) {
      return reject(`destination already exists and is not a directory: ${dest}`);
    }
    const entries = fs.readdirSync(dest);
    if (entries.length > 0) {
      return reject(`destination already exists and is not empty: ${dest} (${entries.length} entr${entries.length === 1 ? "y" : "ies"}) — choose another name or remove it first`);
    }
  }

  return { ok: true, dest };
}
