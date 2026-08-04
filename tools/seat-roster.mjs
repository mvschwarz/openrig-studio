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
// Precedence is presence-based, per the founder ruling and sdk-qa's spike: an
// explicit declaration wins entire, otherwise the rig the studio belongs to
// supplies it, and there is NO fallback to the package fixture on a consumer
// boot. An empty declaration is a declaration — "this app ships without seats" —
// not an absence.

export const DECLARED = "declared";
export const RIG = "rig";
export const NONE = "none";

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
    return { seats: declared, source: DECLARED, note: `${declared.length} seat(s) declared by this studio` };
  }
  if (rig && Array.isArray(nodes) && nodes.length) {
    const seats = nodes
      .map(seatRow)
      .filter((s) => s.seat && !s.seat.includes("undefined"));
    const live = seats.filter((s) => s.status === "running").length;
    return {
      seats,
      source: RIG,
      // Say running-of-total rather than calling them all live. The previous
      // message called 92 nodes "live" while a third of them were not.
      note: `${seats.length} seat(s) from rig ${rig} (${live} running)`,
    };
  }
  return { seats: [], source: NONE, note: ambiguity || "no rig and no declared roster" };
}

// Which rig this studio belongs to. Explicit beats inferred, and inference
// refuses to guess between several — the old code unioned every rig on the box
// and the shell then opened on whichever sorted first, which is not discovery.
export function resolveRig({ declaredRig, whoamiRig, rigsOnBox }) {
  if (declaredRig) return { rig: declaredRig, why: `declared in studio.json` };
  if (whoamiRig) return { rig: whoamiRig, why: `this studio was started from a managed session on ${whoamiRig}` };
  const rigs = [...new Set(rigsOnBox ?? [])];
  if (rigs.length === 1) return { rig: rigs[0], why: `the only rig on this box` };
  if (rigs.length > 1) {
    return {
      rig: null,
      why: `${rigs.length} rigs on this box and none declared — set "rig" in studio.json. ` +
           `Refusing to guess or to union them: ${rigs.join(", ")}`,
    };
  }
  return { rig: null, why: "no rig on this box" };
}
