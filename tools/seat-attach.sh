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
# THE ALLOWLIST IS THE ROSTER — THE SAME FILE, NOT A SECOND DERIVATION.
#
# It was a hardcoded list once, then `rig ps --nodes -A`, i.e. every seat on the
# machine. Both were wrong in the same way, and the second was worse because it
# LOOKED derived: once the launcher narrowed the sidebar to one rig, this file
# still authorized against the whole box, so a caller could ask for
# /chat/?arg=<seat-in-another-rig> and pass the check. The browser only SUGGESTS
# a roster; ?arg is caller-controlled. A UI filter is not an authorization
# boundary, and the comment that used to sit here claimed the two could not
# disagree — which stopped being true the moment the sidebar was scoped and
# nothing here changed.
#
# So authorization now reads the COMPOSED OVERLAY MANIFEST that the shell is
# served from. Not a parallel query that ought to agree — the same artifact.
# Fails closed: no path, no file, no roster, no attach.
set -u
SEAT="${1:-}"
[ -n "$SEAT" ] || { echo "no seat requested"; exit 1; }

# The studio tells us where its composed roster is. Unset means this script was
# invoked outside a studio, which is not a case to be permissive about.
ROSTER="${OPENRIG_STUDIO_SEATS:-}"
if [ -z "$ROSTER" ] || [ ! -f "$ROSTER" ]; then
  echo "no composed roster available, so nothing is authorized to attach"; exit 1
fi
if ! python3 -c '
import json,sys
want, path = sys.argv[1], sys.argv[2]
try:
    seats = json.load(open(path)).get("chatSeats")
except Exception:
    sys.exit(1)
# A roster that is missing or malformed authorizes NOTHING. An empty roster is a
# valid declaration meaning this studio has no seats, and it authorizes nothing
# either — both fail closed, for different reasons that do not need separating
# here.
if not isinstance(seats, list):
    sys.exit(1)
sys.exit(0 if want in {s.get("seat") for s in seats if isinstance(s, dict)} else 1)
' "$SEAT" "$ROSTER"; then
  echo "seat is not on this studio's roster: $SEAT"; exit 1
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
cleanup() { [ -n "${WATCH:-}" ] && kill "$WATCH" 2>/dev/null; tmux kill-session -t "=$GS" 2>/dev/null || true; }
trap cleanup EXIT HUP TERM INT

# THE VIEWER MUST DIE WITH THE SEAT. Grouped sessions share their windows, so
# killing the canonical session leaves the group alive as long as any viewer
# remains — and the PANE KEEPS RUNNING under the viewer. The seat is then gone
# while its process lives on, and anything that asks tmux what is running
# reports a dead seat as alive. That is a viewer owning a lifecycle it must
# never own, and it is worse than a crash because it reads as healthy.
#
# Pruning at attach time is NOT enough, and assuming it was is what left this
# open: pruning cleans up after a death that already happened and does nothing
# about one that happens WHILE attached. So watch the canonical for as long as
# this viewer lives, and take the viewer down with it. Contained entirely in
# the viewer — the seat's own session is never configured or mutated from here.
( while tmux list-sessions -F '#{session_id}' 2>/dev/null | grep -qxF "$SID"; do sleep 2; done
  tmux kill-session -t "=$GS" 2>/dev/null ) &
WATCH=$!

# window-size LARGEST. Grouped sessions share their windows and a window has
# ONE size, so the option decides whose client wins. The default is `latest`,
# which means the most recently attached client resizes the window for
# everyone — one small browser opening a sidebar dragged a seat from 49x57 to
# 49x13 for every attached client, including the agent's own.
#
# Measured with real attached clients (a 200x57 and a 40x12): `latest` gave
# 40x11 to all of them, `largest` gave 200x56. So the small viewer now gets a
# cropped view of a full-size window instead of shrinking the seat, which is
# the right trade — a sidebar must never degrade the session it is watching.
#
# Set on the VIEWER only. Setting it on the canonical seat would work too and
# is exactly the mutation a viewer must not perform; measured that the viewer
# side alone is sufficient.
#
# NOTE FOR ANYONE CHANGING THIS: `latest` IS THE DEFAULT. Setting it is a
# no-op, which is how a first attempt at this fix passed review and changed
# nothing — check `tmux show-options -g window-size` before believing an edit
# here did anything.
tmux new-session -s "$GS" -t "$SID" \; \
  set-option -t "$GS" status off \; \
  set-option -t "$GS" window-size largest \; \
  set-window-option -t "$GS" aggressive-resize on
