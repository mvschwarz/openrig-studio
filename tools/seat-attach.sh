#!/usr/bin/env bash
# Attach a browser terminal to a REAL agent seat.
#
# The web terminal passes ?arg=<seat> as $1. The human then types into that
# seat's actual session — this is not a chat app talking to an agent, it is
# the agent's own terminal in a panel beside the app it is working on.
#
# PORTED from the exploratory studio where this has real use behind it. Two
# lessons in here were paid for and are not obvious:
#
# SPLIT-BRAIN: never target the seat NAME directly. A session GROUP named
# after a replaced seat outlives it — accumulated viewer sessions keep the
# dead window and its orphaned runtime alive, and can shadow name resolution.
# So: prune viewer groups whose canonical member is gone, resolve the seat to
# its CURRENT canonical (non-grouped) session id, group against the ID, and
# kill this viewer on disconnect. VIEWER SESSIONS ARE DISPLAYS ONLY — they
# must never become lifecycle owners of a runtime.
#
# SIZING: attach through a per-connection GROUPED session so each viewer gets
# its own size. A single small attached client otherwise clamps everyone.
#
# WHAT CHANGED IN THE PORT, and it is the fix the original asked for: the
# allowlist was a hardcoded list of seat names, which made the file
# box-specific and had to be kept in sync by hand with the roster the sidebar
# renders. Two places deriving one property drift silently — you get a tile
# for a seat that refuses to attach. The allowlist is now DERIVED from the
# live rig, so the roster and the allowlist cannot disagree: if it is not a
# seat on this box right now, it does not attach.
set -u
SEAT="${1:-}"
[ -n "$SEAT" ] || { echo "no seat requested"; exit 1; }

# Derived allowlist. Never an arbitrary tmux attach: the seat must be a live
# node on this box's rig. Failing closed is deliberate — if the rig cannot be
# asked, nothing attaches.
if ! command -v rig >/dev/null 2>&1; then
  echo "no rig on this box, so there is no roster to attach to"; exit 1
fi
if ! rig ps --nodes -A --json 2>/dev/null \
  | python3 -c '
import json,sys
want = sys.argv[1]
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)
nodes = d if isinstance(d, list) else d.get("nodes", [])
names = {n.get("canonicalSessionName") or f'"'"'{n.get("logicalId")}@{n.get("rigName")}'"'"' for n in nodes}
sys.exit(0 if want in names else 1)
' "$SEAT"; then
  echo "seat is not on this box's live roster: $SEAT"; exit 1
fi

# Prune orphaned viewer groups: a viewer session whose group no longer holds a
# non-viewer member is anchored to a replaced seat, and is the only thing
# keeping that dead window and runtime alive. Seat-agnostic and safe — a live
# seat always sits inside its own group.
tmux list-sessions -F '#{session_name}|#{session_group}' 2>/dev/null | awk -F'|' '
  $2 != "" { members[$2] = members[$2] $1 "\n"; if ($1 !~ /^seatview-/) live[$2] = 1 }
  END { for (g in members) if (!(g in live)) printf "%s", members[g] }' |
while IFS= read -r stale; do
  [ -n "$stale" ] && tmux kill-session -t "=$stale" 2>/dev/null
done

# Resolve to the canonical session ID by EXACT NAME. tmux forbids duplicate
# session names and every viewer clone is seatview-*, so the name is the
# canonical discriminator. Do NOT use #{session_grouped} here — it flips to 1
# on the canonical session too, once any viewer groups onto it.
SID="$(tmux list-sessions -F '#{session_id}|#{session_name}' 2>/dev/null |
  awk -F'|' -v s="$SEAT" '$2 == s { print $1; exit }')"
if [ -z "$SID" ]; then
  echo "seat has no live session to attach to: $SEAT"; exit 1
fi

GS="seatview-$$-$RANDOM"
cleanup() { tmux kill-session -t "=$GS" 2>/dev/null || true; }
trap cleanup EXIT HUP TERM INT
tmux new-session -s "$GS" -t "$SID" \; set-option -t "$GS" status off \; set-window-option aggressive-resize on
