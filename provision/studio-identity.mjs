#!/usr/bin/env node
// Decide whether a studio already answering on a port is THIS studio.
//
// The provisioner used to ask only whether something answered `/api/contract`
// and treat any success as "mine". review-r1 measured that a server returning a
// body which is not a studio contract satisfies that check, and that two genuine
// studios are indistinguishable by contractVersion, runtime and capabilities.
//
// The failure that produces is not a broken install, it is a GREEN one: with a
// sibling studio already on the port, the provisioner reuses it, never starts the
// studio it just installed, and the verifier then passes against the sibling's
// surfaces. Wrong, and reported as success.
//
// THE PROBE LIVES HERE TOO, and that is the correction from sdk-qa's first pass.
// The classification was written in shell, where `curl -f` reports a refused
// connection and an HTTP 404 with the same failure — so a foreign listener that
// answered 404 at `/api/contract` was classified "nothing", launched into, and
// then verified against. The three-state model was right and the shell could not
// express it. One place computes this now; the shell asks and does not classify.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Three outcomes, deliberately not two: "nothing is listening" and "something is
// listening and it is not mine" call for opposite actions, and collapsing them is
// how a stranger's studio gets adopted.
export const REUSE = "reuse";
export const NOT_MINE = "not-mine";
export const NOTHING = "nothing";

// Two paths are the same directory when they resolve to the same filesystem
// object — not when they are spelled the same way. `STUDIO_DIR=./studio`, a
// trailing slash and a symlinked home are all ordinary supported input, and a
// raw string compare turns each of them into a permanent refusal on a rerun that
// should have been idempotent. The runtime itself reports `path.resolve`'d
// output, so a comparison that is not at least as canonical cannot match it.
//
// realpath needs the path to exist; on a first run the overlay does not yet.
// Falling back to resolve keeps the non-existent case comparable without
// pretending it was canonicalised.
export function canonical(p) {
  if (typeof p !== "string" || !p) return null;
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const sameDir = (a, b) => {
  const ca = canonical(a), cb = canonical(b);
  return ca !== null && cb !== null && ca === cb;
};

export function reuseDecision({ body, expectedDir }) {
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return { outcome: NOT_MINE, reason: "something is serving this port but /api/contract did not return JSON — not a studio" };
  }
  if (!doc || typeof doc !== "object") {
    return { outcome: NOT_MINE, reason: "something is serving this port and /api/contract returned JSON that is not an object — not a studio" };
  }
  // ESTABLISH THAT THIS IS A STUDIO BEFORE ASKING WHICH STUDIO IT IS. The first
  // version checked only that `contractVersion` was a string and `manifest` was
  // truthy, so a hand-written object carrying nothing but the expected `dir` was
  // accepted as a studio — sdk-qa reproduced it with two three-key impostors.
  // The checks below are the ones contract-meta.md tells every consumer to make
  // (capability present + same major), plus the runtime identity: this caller
  // installed THIS SDK's runtime, so it may require that runtime by name rather
  // than accept anything implementing the contract.
  const version = typeof doc.contractVersion === "string" ? doc.contractVersion : null;
  const major = version ? version.split(".")[0] : null;
  if (major !== "0") {
    return { outcome: NOT_MINE, reason: `something is serving this port but reports contractVersion ${JSON.stringify(doc.contractVersion)} — not a studio contract this run understands` };
  }
  if (doc.runtime?.name !== "openrig-studio") {
    return { outcome: NOT_MINE, reason: `something is serving this port and answering /api/contract, but it is not an openrig studio runtime (runtime.name=${JSON.stringify(doc.runtime?.name)})` };
  }
  if (!Array.isArray(doc.capabilities) || !doc.capabilities.includes("contract.meta")) {
    return { outcome: NOT_MINE, reason: "something is serving this port that claims to be a studio but does not advertise the contract.meta capability — not a studio contract" };
  }
  if (!doc.manifest || typeof doc.manifest !== "object") {
    return { outcome: NOT_MINE, reason: "a studio contract without a manifest report — not a response this decision can be made from" };
  }

  const dir = doc.manifest.consumer?.dir;
  if (typeof dir !== "string") {
    return { outcome: NOT_MINE, reason: "a studio is serving this port, but with no overlay configured (manifest.consumer is null), so it cannot be the studio this run installed" };
  }
  if (!sameDir(dir, expectedDir)) {
    // Name BOTH. A refusal that says only "wrong studio" sends an operator
    // looking for the wrong thing.
    return { outcome: NOT_MINE, reason: `a DIFFERENT studio is serving this port: it serves ${dir}, this run installed ${expectedDir}` };
  }
  return { outcome: REUSE, reason: `studio already serving ${dir} — reusing it` };
}

// TCP FIRST, and only a missing listener may be "nothing".
//
// This is the whole of sdk-qa's MUST-FIX 1: `curl -f` cannot tell a refused
// connection from an HTTP 404, so a foreign server answering 404 at
// /api/contract read as an empty port. Anything holding the port that does not
// prove itself is foreign, because launching into it fails and verifying against
// it succeeds — the second being the dangerous one.
export async function probePort({ port, expectedDir, host = "127.0.0.1", timeoutMs = 5000 }) {
  const listening = await new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
  if (!listening) return { outcome: NOTHING, reason: "nothing is listening on this port" };

  let res;
  try {
    res = await fetch(`http://${host}:${port}/api/contract`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { outcome: NOT_MINE, reason: `something holds this port but /api/contract could not be read (${e.message}) — refusing to treat an occupied port as empty` };
  }
  if (!res.ok) {
    return { outcome: NOT_MINE, reason: `something holds this port and answered /api/contract with HTTP ${res.status} — occupied, and not a studio this run may use` };
  }
  return reuseDecision({ body: await res.text(), expectedDir });
}

// CLI: `studio-identity.mjs <port> <expectedDir>`. Reason on stdout; exit 0
// reuse, 3 not-mine, 4 nothing-listening. Three exit codes because the shell has
// three actions, and the previous shape made the shell infer the third.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { outcome, reason } = await probePort({
    port: Number(process.argv[2]),
    expectedDir: process.argv[3],
  });
  process.stdout.write(reason + "\n");
  process.exit(outcome === REUSE ? 0 : outcome === NOT_MINE ? 3 : 4);
}
