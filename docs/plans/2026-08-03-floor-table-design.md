# FLOOR Table and AGENTS Retirement Design

## Goal

Make FLOOR a dense, glanceable operational view while retiring the redundant
AGENTS surface without removing the shared host capabilities that FILES uses.

## FLOOR structure

FLOOR keeps its current welcome content and event-driven data flow. The three
summary cards become a compact inline metrics strip. Seat cards become a real
semantic table with columns for seat, pod/member, state, lifecycle, age, and
pending work. Queue entries become a second semantic table below the seat
table. Both tables use horizontal overflow at narrow widths instead of
collapsing back into cards.

The visual rhythm follows OpenRig's topology table: small uppercase headers,
compact monospace values, quiet row separators, persistent action affordances,
and status encoded with both a pip and text. The implementation remains a
standalone HTML surface with no OpenRig UI dependency.

## Preserved behavior

- The consumer-declared `welcome` block remains generic and first in the page.
- The caption names every rig represented in the live payload.
- `open-agent` continues to use one delegated click handler so refreshes cannot
  detach the control.
- Live refresh continues through the existing event stream with polling as the
  fallback.
- `no-rig`, `no-rig-cli`, and `rig-error` remain visibly distinct. Every
  detached state shows a down signal and an explanatory message; none can look
  like a healthy empty floor.

## AGENTS retirement

Remove the AGENTS app directory from the public apps repository and remove it
from consumer configuration. Keep `studio-host` and all of its endpoints: the
provider is shared by FILES and by the studio shell. Git history is the archive;
leaving the retired surface installable would contradict the product decision.

Before removing the AGENTS-only degraded-state test, add equivalent FLOOR
coverage in the SDK repository. This moves the guard to the surface that now
owns the behavior instead of silently dropping it with the retired app.

## Verification

1. A source-level contract test pins semantic table markup, the six seat
   columns, queue table, preserved welcome and delegated agent action, all-rig
   caption logic, and distinct detached-state/down-signal behavior.
2. The SDK's complete test suite stays green.
3. The studio-host suite stays green after the obsolete AGENTS-only tests are
   removed from its script.
4. A clean local browser run checks healthy and crafted detached states.
5. The pushed revisions are deployed to a real studio box. Browser verification
   confirms the six-surface rail, dense FLOOR tables, FILES behavior, and live
   seat-terminal attachment.
