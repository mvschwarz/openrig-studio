#!/usr/bin/env node
// Decide whether a studio already answering on a port is THIS studio.
//
// The provisioner used to ask only whether something answered `/api/contract`
// and treat any success as "mine". review-r1 measured that a server returning a
// body which is not a studio contract at all satisfies that check, and read that
// every genuine studio on a box returns the same `contractVersion`, `runtime` and
// `capabilities` — so there was nothing to tell two studios apart.
//
// The failure that produces is not a broken install, it is a GREEN one: with a
// sibling studio already on the port, the provisioner reuses it, never starts the
// studio it just installed, and the verifier then passes against the sibling's
// surfaces. Wrong, and reported as success.
//
// `manifest.consumer.dir` is the discriminator, and as of this slice it is
// documented contract rather than a field that happened to be there
// (contract/manifest.md). This module is the whole decision, kept pure so the
// cases below can be tested without standing up two studios.

// Three outcomes, deliberately not two: "nothing is listening" and "something is
// listening and it is not mine" call for opposite actions, and collapsing them is
// how a stranger's studio gets adopted.
export const REUSE = "reuse";
export const NOT_MINE = "not-mine";

export function reuseDecision({ body, expectedDir }) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return {
      outcome: NOT_MINE,
      reason: "something is serving this port but /api/contract did not return JSON — not a studio",
    };
  }
  if (!doc || typeof doc !== "object" || typeof doc.contractVersion !== "string" || !doc.manifest) {
    return {
      outcome: NOT_MINE,
      reason: "something is serving this port and answering /api/contract, but the response carries " +
              "no studio contract (no contractVersion / manifest) — not a studio",
    };
  }
  const dir = doc.manifest.consumer?.dir;
  if (typeof dir !== "string") {
    return {
      outcome: NOT_MINE,
      reason: "a studio is serving this port, but with no overlay configured (manifest.consumer is " +
              "null), so it cannot be the studio this run installed",
    };
  }
  if (dir !== expectedDir) {
    // Name BOTH. A refusal that says only "wrong studio" sends an operator
    // looking for the wrong thing — and the likeliest cause is not a sibling at
    // all, it is the same studio reached by a different path spelling.
    return {
      outcome: NOT_MINE,
      reason: `a DIFFERENT studio is serving this port: it serves ${dir}, this run installed ${expectedDir}`,
    };
  }
  return { outcome: REUSE, reason: `studio already serving ${dir} — reusing it` };
}

// CLI: body on stdin, expected dir as argv. Exit 0 reuse, 3 not-mine, and the
// reason on stdout either way so the run can print it.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const { outcome, reason } = reuseDecision({
    body: Buffer.concat(chunks).toString("utf8"),
    expectedDir: process.argv[2],
  });
  process.stdout.write(reason + "\n");
  process.exit(outcome === REUSE ? 0 : 3);
}
