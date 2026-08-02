// Emit — stage every file into a sibling temp directory, then ONE atomic
// rename into place.
//
// Why a sibling and not the system temp dir: rename() is only atomic within a
// filesystem. A sibling of the destination is guaranteed to be on the same
// filesystem; /tmp is not, and would silently degrade to a copy that can be
// interrupted halfway.
//
// The guarantee this buys: the destination either does not exist, or is the
// complete project. A crash mid-generation leaves a hidden staging directory
// that is removed on the way out — never a half-written project a developer
// might mistake for a working one.

import fs from "node:fs";
import path from "node:path";

export function emitProject(dest, files) {
  const parent = path.dirname(dest);
  const staging = fs.mkdtempSync(path.join(parent, ".create-studio-staging-"));

  // Test affordance ONLY: throw after N files have been staged, to demonstrate
  // that a mid-generation failure leaves no partial project. Inert when unset.
  const failAfter = Number(process.env.OPENRIG_STUDIO_CREATE_FAIL_AFTER || 0);

  let staged = 0;
  try {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(staging, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      staged += 1;
      if (failAfter > 0 && staged >= failAfter) {
        throw new Error(
          `OPENRIG_STUDIO_CREATE_FAIL_AFTER=${failAfter} — simulated mid-generation failure after ${staged} file(s)`
        );
      }
    }
    // POSIX rename() onto an existing EMPTY directory succeeds; admission has
    // already refused a non-empty destination.
    fs.renameSync(staging, dest);
    return { dest, files: Object.keys(files) };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}
