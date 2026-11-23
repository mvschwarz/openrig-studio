#!/usr/bin/env node
// Who appears in the agent sidebar, and where that roster came from.
//
// Three measured defects this replaces, all on the `tools/studio.mjs` boot path:
//
//   * a consumer's own declared `chatSeats` was DISCARDED — the launcher passed
//     the live roster unconditionally, so the documented direct-runtime path and
//     the documented launcher path gave different answers for the same studio;
//   * the roster was `rig ps --nodes -A`, the WHOLE FLEET — 92 nodes across 12
//     rigs on this host — and every one of them was printed as "live" when a
//     third were detached or exited;
//   * with no rig at all the overlay omitted `chatSeats` entirely, so the
//     runtime fell through to the package document and a real box showed the
//     SDK's invented `studio-lead@fixture` seat.
//
// Precedence is presence-based: an
// explicit declaration wins entire, otherwise the rig the studio belongs to
// supplies it, and there is NO fallback to the package fixture on a consumer
// boot. An empty declaration is a declaration — "this app ships without seats" —
// not an absence.

export const DECLARED = "declared";
export const RIG = "rig";
export const NONE = "none";
export const UNREACHABLE = "unreachable";
// "rig": "*" in studio.json is every rig on this box, and only ever a declaration: nothing infers it.
export const ALL_RIGS = "*";

// The `rig ps --nodes` arguments for a resolved rig: one rig, or the whole box for "*".
export const rigNodeArgs = (rig) => (rig === ALL_RIGS ? ["-A"] : ["--rig", rig]);

// A spec member that is not running is still a member. Dropping it would turn
// "the agents this box is configured with" into "the agents alive this second",
// which is a different claim and a smaller one — and it would make the sidebar
// shrink silently when something crashes.
const seatRow = (n) => ({
  seat: n.canonicalSessionName || `${n.logicalId}@${n.rigName}`,
  name: n.logicalId || n.canonicalSessionName,
  status: n.sessionStatus || "unknown",
});

export function resolveRoster({ declared, nodes, rig, ambiguity }) {
  // Array.isArray, not truthiness: [] is a meaningful override and `.length`
  // would silently treat it as "nothing declared" — which is exactly how the
  // fixture leaked in the first place.
  if (Array.isArray(declared)) {
    return {
      seats: declared,
      source: DECLARED,
      note: `${declared.length} seat(s) declared by this studio`,
    };
  }
  // The rig is known but couldn't be read: say so. An empty roster here would look like "this rig has no seats".
  if (rig && nodes && !Array.isArray(nodes) && nodes.error) {
    return {
      seats: [],
      source: UNREACHABLE,
      note: `${rig === ALL_RIGS ? "rigs" : `rig ${rig}`} unreachable: ${nodes.error}`,
    };
  }
  if (rig && Array.isArray(nodes) && nodes.length) {
    const seats = nodes.map(seatRow).filter((s) => s.seat && !s.seat.includes("undefined"));
    const live = seats.filter((s) => s.status === "running").length;
    return {
      seats,
      source: RIG,
      // Say running-of-total rather than calling them all live. The previous
      // message called 92 nodes "live" while a third of them were not.
      note: `${seats.length} seat(s) from ${rig === ALL_RIGS ? "every rig on this box" : `rig ${rig}`} (${live} running)`,
    };
  }
  return { seats: [], source: NONE, note: ambiguity || "no rig and no declared roster" };
}

// Which rig this studio belongs to. Explicit beats inferred, and inference
// refuses to guess between several — the old code unioned every rig on the box
// and the shell then opened on whichever sorted first, which is not discovery.
//
// A Studio with a server hook installed is served to other people, so it never infers a rig: a rig's roster is the
// list of seat terminals its visitors can attach to, and an inferred one would hand them the terminals of whatever rig
// it was started from. Only a declared rig (or "*") counts there; the loopback default keeps inferring for its owner.
export function resolveRig({ declaredRig, whoamiRig, rigsOnBox, published = false }) {
  if (declaredRig === ALL_RIGS)
    return { rig: ALL_RIGS, why: "declared in studio.json: every rig on this box" };
  if (declaredRig) return { rig: declaredRig, why: `declared in studio.json` };
  if (published) {
    const seen = whoamiRig || ([...new Set(rigsOnBox ?? [])].length === 1 ? rigsOnBox[0] : null);
    return {
      rig: null,
      why:
        'choose a rig in studio.json ("rig": "<name>"): a Studio with a server hook never guesses one' +
        (seen ? ` (started from ${seen})` : ""),
    };
  }
  if (whoamiRig)
    return {
      rig: whoamiRig,
      why: `this studio was started from a managed session on ${whoamiRig}`,
    };
  const rigs = [...new Set(rigsOnBox ?? [])];
  if (rigs.length === 1) return { rig: rigs[0], why: `the only rig on this box` };
  if (rigs.length > 1) {
    return {
      rig: null,
      why:
        `${rigs.length} rigs on this box and none declared — set "rig" in studio.json. ` +
        `Refusing to guess or to union them: ${rigs.join(", ")}`,
    };
  }
  return { rig: null, why: "no rig on this box" };
}

// A rig's roster, kept current while the Studio runs. Boot is the worst moment to ask a busy daemon, so one slow answer
// used to leave the Studio with no seats and no terminal until its next restart. A refresh re-reads the rig: a good read
// that changed the seats rewrites the manifest (the shell and the attach allowlist both read that file, so nothing
// restarts); an unreachable read keeps the last good roster and says so once, rather than emptying the sidebar on a blip.
export function createRosterRefresh({ rig, read, write, initial = [], log = () => {} }) {
  let seats = initial;
  let unreachable = false;
  return async function refresh() {
    let nodes;
    try {
      nodes = await read(rigNodeArgs(rig));
    } catch (e) {
      nodes = { error: String(e?.message || e) };
    }
    const next = resolveRoster({ declared: undefined, nodes, rig });
    if (next.source === UNREACHABLE) {
      if (!unreachable)
        log(`  seats   : ${next.note}; keeping the last good roster (${seats.length} seat(s))`);
      unreachable = true;
      return { changed: false, source: next.source };
    }
    unreachable = false;
    if (JSON.stringify(next.seats) === JSON.stringify(seats))
      return { changed: false, source: next.source };
    seats = next.seats;
    write(seats);
    log(`  seats   : roster refreshed: ${next.note}`);
    return { changed: true, source: next.source };
  };
}
