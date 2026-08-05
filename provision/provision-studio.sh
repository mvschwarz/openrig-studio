#!/usr/bin/env bash
# provision-studio.sh — bare host -> working OpenRig Studio, in one command.
#
# STATUS: the INSTALL below is proven on a real box. The HOST BOOTSTRAP (step 1)
# is now proven too — against a stock ubuntu:24.04 container carrying no node,
# npm or git. That was the first execution of the bootstrap branch, and it is
# what surfaced the defects since fixed here; every earlier host already had
# node, so the branch had always been skipped and nothing had ever exercised it.
#
# A CONTAINER IS NOT A VPS, and holding that line is this header's job: nothing
# here has provisioned real hosting, and persistence across a reboot is still
# untested. The container had no init system, so the systemd path went
# unexercised and the direct-start degrade is what actually ran.
#
# The full assessment of what is proven versus untested is tracked separately
# and is not part of this repo. The script ships; the assessment does not.
#
# Design constraints this script is written to:
#   * NON-INTERACTIVE. No prompts, ever — it must be callable unattended from
#     automation. All input is env; all output is a machine-readable summary line.
#   * IDEMPOTENT. Re-running must converge, not duplicate. Safe to retry.
#   * VERIFIES BY EFFECT, not by exit code. Counting surfaces is not an app
#     check — a box with zero apps kept that count true.
#   * INSTALLS FROM PUBLIC SOURCES ONLY. No credentials ever land on the target.
#     That is hygiene expressed as architecture rather than as a gate: there is
#     nothing to leak, so nothing has to remember not to leak it.
#
# Usage:
#   ./provision-studio.sh                       # curated default app set
#   APPS="workspace files canvas" ./provision-studio.sh    # exactly these
#   APPS=all ./provision-studio.sh              # everything the repo ships
#   STUDIO_PORT=8890 STUDIO_USER=studio ./provision-studio.sh
#   ./provision-studio.sh --dry-run             # print plan, touch nothing
#
# A bare host gets FOUR apps, not everything: workspace, rig-designer, factory,
# files. Two providers, no ffmpeg, and no licence to go and acquire. The run
# prints what it left out and how to ask for it.
#
# THE SYSTEMD UNIT IS NAMED PER STUDIO, not per box:
#   openrig-studio-<dir-name>-<hash-of-STUDIO_DIR>.service
# Stable across reprovisions of one studio, distinct between different ones, and
# printed by the run. It used to be `openrig-studio.service` for everybody, so a
# second provision silently took over the first studio's persistence — invisible
# until a reboot, because the old process kept running and answering. A unit
# belonging to a different studio is now REFUSED rather than overwritten.
#
set -euo pipefail

SDK_REPO="${SDK_REPO:-https://github.com/mvschwarz/openrig-studio.git}"
APPS_REPO="${APPS_REPO:-https://github.com/mvschwarz/openrig-studio-apps.git}"
STUDIO_DIR="${STUDIO_DIR:-$HOME/studio}"
MEDIA_DIR="${MEDIA_DIR:-$HOME/media}"
STUDIO_PORT="${STUDIO_PORT:-8890}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# Explicit APPS is an instruction; absent APPS gets the CURATED SET below.
#
# WHY NOT EVERYTHING. Installing whatever the repository happens to ship put 13
# apps and 7 providers on a fresh box — including a video toolchain that wants
# ffmpeg and a canvas that needs a licence the user has to go and get. A first
# boot should show someone that the studio works, not hand them every dependency
# the ecosystem has ever needed.
#
# WHY NOT A PINNED LIST EITHER, which is the failure this replaced: the apps
# repository moves on its own schedule, so a provisioner asserting yesterday's
# names fails on a box that did nothing wrong. The default is therefore
# INTERSECTED with what the clone actually ships, and anything in the curated set
# that has since been renamed or removed is reported rather than fatal.
#
# THE SET, and why each earns a slot on a bare host:
#   workspace     - no provider at all; the thing you actually work in
#   rig-designer  - no provider at all; shows the rig being driven
#   factory       - studio-factory; the rig floor, which is what OpenRig IS
#   files         - studio-host; browsing the box, the most universal verb set
# Two providers, no ffmpeg, no licence to acquire. Everything else is one
# `APPS=` away and the summary says so.
APPS_DEFAULT="workspace rig-designer factory files"
APPS_EXPLICIT="${APPS:+yes}"
# `APPS=all` is the documented escape hatch back to install-everything.
APPS_ALL=""
if [ "${APPS:-}" = "all" ]; then APPS_ALL="yes"; APPS_EXPLICIT=""; fi
APPS="${APPS:-}"
# Split ONCE, explicitly, into an array. The obvious `for a in $APPS` relies on
# unquoted word-splitting, which bash does and zsh does NOT — so the same line
# yields six apps in a script and one fused string pasted into a zsh terminal,
# producing a studio.json that is still VALID JSON and completely wrong. An
# array removes the shell-dependency instead of documenting it.
read -ra APP_LIST <<< "$APPS"   # may be empty here; filled after the clone
DRY_RUN=0
# NOT `[ ... ] && DRY_RUN=1` — but the reason is narrower than this comment used
# to claim, and it was measured. A failing `&&`-tail does NOT trip `set -e`
# mid-script; execution continues. It bites only in FINAL-COMMAND position, where
# the list's status becomes the script's exit status. The `if` below is still the
# right shape for a value the whole run depends on, and it costs nothing — but
# the overstated version of this warning was being read as a general prohibition
# on a construct this file uses correctly elsewhere.
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

STEP=0
note() { STEP=$((STEP+1)); printf '\n[%02d] %s\n' "$STEP" "$*"; }
warn() { printf '  !! %s\n' "$*" >&2; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  would: %s\n' "$*"; else eval "$@"; fi; }

# --- 0. preflight ------------------------------------------------------------
note "preflight"
# ORDER MATTERS. The platform check comes FIRST, before anything that assumes a
# Linux filesystem. `. /etc/os-release` on a host without that file terminates
# the script under `set -e` (a `|| true` does not reliably save a failed source),
# which used to kill it here with a bare exit 1 — so the very guard meant to
# print a clear refusal was unreachable on exactly the platform it was written
# to catch. Guard first, then read.
if [ "$(uname -s)" != "Linux" ]; then
  warn "not Linux (this is $(uname -s)) — this script targets Ubuntu/Debian. Refusing."
  exit 2
fi
if [ -r /etc/os-release ]; then . /etc/os-release; fi
printf '  host: %s %s (%s)\n' "${ID:-unknown}" "${VERSION_ID:-?}" "$(uname -m)"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"
  else warn "no root and no passwordless sudo — will use the rootless path (nvm + no linger)"; fi
fi

# --- 1. host bootstrap: node, npm, git ---------------------------------------
# THE GENUINELY UNTESTED PART. The box this was proven on already had all
# three; a fresh one will not. Two paths, because a rootless box is real.
note "host bootstrap (node >=${NODE_MAJOR}, npm, git)"
have_node() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; }

if have_node && command -v git >/dev/null 2>&1; then
  printf '  already present: node %s, git %s\n' "$(node -v)" "$(git --version | awk '{print $3}')"
else
  if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
    run "$SUDO apt-get update -qq"
    run "$SUDO apt-get install -y -qq curl ca-certificates git"
    # NodeSource: Ubuntu's own node is too old on every LTS that matters.
    # NOT `| $SUDO -E bash -`: as root SUDO is EMPTY, so that expands to
    # `| -E bash -` and the shell tries to execute `-E`. This broke node
    # installation on every fresh VPS, where root is the normal case — and the
    # dry-run printed the broken line without anyone noticing, because reading
    # `|  -E bash -` does not look wrong until you run it.
    if [ -n "$SUDO" ]; then
      run "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | $SUDO -E bash -"
    else
      run "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    fi
    run "$SUDO apt-get install -y -qq nodejs"
  else
    # Rootless fallback. Leaves node only in this user's shell — the systemd
    # unit below therefore uses an ABSOLUTE node path, never a login shell.
    run "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    run "export NVM_DIR=\"\$HOME/.nvm\" && . \"\$NVM_DIR/nvm.sh\" && nvm install ${NODE_MAJOR}"
  fi
fi
NODE_BIN="$(command -v node || echo "$HOME/.nvm/versions/node/current/bin/node")"

# --- 2. fetch (public, anonymous, no credentials) ----------------------------
note "fetch sources"
run "mkdir -p '$STUDIO_DIR' '$MEDIA_DIR'/{footage,projects,canvases}"
clone_or_update() { # $1 url  $2 dest
  if [ -d "$2/.git" ]; then run "git -C '$2' pull --ff-only -q"
  else run "git clone --depth 1 -q '$1' '$2'"; fi
}
clone_or_update "$SDK_REPO"  "$STUDIO_DIR/sdk"
clone_or_update "$APPS_REPO" "$STUDIO_DIR/apps"

# --- 2b. discover apps -------------------------------------------------------
# Ask the repository what it ships rather than asserting what it shipped when
# this script was written. An explicitly-requested app that is missing is an
# ERROR (you asked for it by name); an app the repo simply no longer carries is
# not this script's business to know about in advance.
note "apps"
if [ "$DRY_RUN" = 0 ]; then
  if [ -z "$APPS_EXPLICIT" ]; then
    AVAILABLE=(); for d in "$STUDIO_DIR"/apps/apps/*/; do [ -d "$d" ] && AVAILABLE+=("$(basename "$d")"); done
    printf '  repository ships %d app(s): %s\n' "${#AVAILABLE[@]}" "${AVAILABLE[*]}"
    [ "${#AVAILABLE[@]}" -gt 0 ] || { warn "no apps found under $STUDIO_DIR/apps/apps — refusing to write an empty studio"; exit 3; }

    if [ -n "$APPS_ALL" ]; then
      APP_LIST=("${AVAILABLE[@]}")
      printf '  APPS=all -> installing every app the repository ships\n'
    else
      # Intersect the curated set with what is actually there. A curated name that
      # has been renamed or dropped is REPORTED, never fatal and never silent —
      # a default that quietly installs three of four looks identical to one that
      # installed all four.
      APP_LIST=(); MISSING=()
      for a in $APPS_DEFAULT; do
        if [ -d "$STUDIO_DIR/apps/apps/$a" ]; then APP_LIST+=("$a"); else MISSING+=("$a"); fi
      done
      # NO SILENT CAPS: say what was left out and how to get it.
      SKIPPED=()
      for a in "${AVAILABLE[@]}"; do
        case " ${APP_LIST[*]} " in *" $a "*) ;; *) SKIPPED+=("$a");; esac
      done
      printf '  installing the curated default (%d of %d): %s\n' \
        "${#APP_LIST[@]}" "${#AVAILABLE[@]}" "${APP_LIST[*]}"
      [ "${#SKIPPED[@]}" -eq 0 ] || printf '  not installed: %s\n     (add them with APPS="%s ..." or install everything with APPS=all)\n' \
        "${SKIPPED[*]}" "${APP_LIST[*]}"
      [ "${#MISSING[@]}" -eq 0 ] || warn "curated app(s) not in this repository, skipped: ${MISSING[*]}"
      [ "${#APP_LIST[@]}" -gt 0 ] || { warn "none of the curated apps (${APPS_DEFAULT}) exist in this repository — pass APPS=... explicitly or APPS=all"; exit 3; }
    fi
  else
    printf '  using the requested app list: %s\n' "${APP_LIST[*]}"
    for a in "${APP_LIST[@]}"; do
      [ -d "$STUDIO_DIR/apps/apps/$a" ] || { warn "requested app '$a' is not in the apps repository — refusing to continue"; exit 3; }
    done
  fi
fi

# --- 3. studio.json ----------------------------------------------------------
# One binding per root KIND. The four kinds are declared by the app manifests:
# canvas, footage, media, project. Getting these wrong is a silent mis-wire.
note "write studio.json"
# Root KINDS come from the app manifests too. Hardcoding them has the same rot
# as hardcoding the app list: an app added tomorrow can declare a kind this
# script has never heard of, and the studio then refuses to start on a box that
# did nothing wrong. Known kinds keep their conventional directory; anything new
# gets $MEDIA_DIR/<kind>, created and reported as a GENERATED default so nobody
# mistakes it for a considered choice.
if [ "$DRY_RUN" = 0 ]; then
  # Kinds are resolved AND serialized by root-bindings.mjs, never looped over
  # here. A shell loop over an unquoted $ROOT_KINDS word-splits AND pathname-
  # globs names that came out of somebody else's manifest: "footage archive"
  # bound two kinds nobody declared, and "zzz*" bound filenames from whatever
  # directory the provisioner happened to run in. Both wrote VALID JSON, so the
  # validator below could not see either. Structured data does not round-trip
  # through the shell's word list — see that file and test/root-bindings.test.mjs,
  # whose controls plant both defeating inputs.
  BIND_MJS="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/root-bindings.mjs"
  # Piped from curl there is no sibling to find, so fall back to the clone made
  # in step 2 — same repo, same commit as the studio about to run.
  [ -f "$BIND_MJS" ] || BIND_MJS="$STUDIO_DIR/sdk/provision/root-bindings.mjs"
  ROOTS_JSON="$("$NODE_BIN" "$BIND_MJS" "$STUDIO_DIR/apps/apps" "$MEDIA_DIR" "${APP_LIST[@]}")"

  cat > "$STUDIO_DIR/studio.json" <<JSON
{
  "port": ${STUDIO_PORT},
  "appsRoot": "${STUDIO_DIR}/apps",
  "apps": [$(printf '"%s",' "${APP_LIST[@]}" | sed 's/,$//')],
  "roots": ${ROOTS_JSON}
}
JSON
  "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$STUDIO_DIR/studio.json" \
    || { warn "generated studio.json is not valid JSON"; exit 4; }
  printf '  wrote %s\n' "$STUDIO_DIR/studio.json"
fi

# --- 4. provider deps --------------------------------------------------------
# `npm ci` REQUIRES a lockfile and EXITS 1 without one — it does not skip. That
# used to abort this step on studio-host every run; fixed upstream in
# openrig-studio-apps c0df1be (verified present on public main), so all three
# providers are `npm ci` clean today. The branch below stays anyway: a provider
# added tomorrow without a lockfile must degrade loudly, not abort the install,
# and the step must never be a no-op that looks like success.
note "provider dependencies"
# QUIET ON SUCCESS, LOUD ON FAILURE. These ran under `--silent`, which suppresses
# npm's ERRORS as well as its progress — so a provider whose install failed
# aborted the script (set -e) with no output naming what went wrong. A registry
# 404, a bad engine constraint and a network timeout all produced the same thing:
# nothing. The operator is left with a dead end at the exact moment they most need
# the text, and the obvious next move — re-run it — reproduces the silence.
#
# Output is captured rather than streamed so a healthy run stays as quiet as it
# was, and the whole log is printed only when there is a failure to explain.
install_provider_deps() {
  local label="$1" cmd="$2" log rc
  if [ "$DRY_RUN" = 1 ]; then printf '  would: %s\n' "$cmd"; return 0; fi
  log=$(mktemp "${TMPDIR:-/tmp}/provider-deps-XXXXXX")
  set +e; eval "$cmd" > "$log" 2>&1; rc=$?; set -e
  if [ $rc -ne 0 ]; then
    warn "provider '$label' dependency install FAILED (exit $rc) — npm said:"
    sed 's/^/    | /' "$log" >&2
    printf '    (command: %s)\n' "$cmd" >&2
    rm -f "$log"
    return $rc
  fi
  rm -f "$log"
  return 0
}

# ONLY THE PROVIDERS THE ENABLED APPS ACTUALLY NEED.
#
# This used to loop over every provider directory on disk, so a provider nobody
# asked for could stop the whole provision — and did, on a real VPS. A box asking
# for four apps should not be blocked by the eleventh provider.
#
# It also made the curated app default a half-truth: selecting four apps still
# installed all seven providers' dependencies, so "two providers, no ffmpeg" was
# a claim about the app list rather than about what actually gets installed.
# Resolution is in node because it walks JSON and returns a set; the result is
# read LINE BY LINE rather than word-split.
NEEDED_PROVIDERS=()
if [ "$DRY_RUN" = 0 ]; then
  while IFS= read -r line; do [ -n "$line" ] && NEEDED_PROVIDERS+=("$line"); done < <(
    "$NODE_BIN" "$(dirname "$0")/needed-providers.mjs" "$STUDIO_DIR/apps" "${APP_LIST[@]}" 2>/dev/null || true)
fi
ALL_PROVIDERS=(); for d in "$STUDIO_DIR"/apps/providers/*/; do [ -d "$d" ] && ALL_PROVIDERS+=("$(basename "$d")"); done
printf '  %d of %d provider(s) needed by the enabled apps: %s\n' \
  "${#NEEDED_PROVIDERS[@]}" "${#ALL_PROVIDERS[@]}" "${NEEDED_PROVIDERS[*]:-none}"

for n in "${NEEDED_PROVIDERS[@]}"; do
  p="$STUDIO_DIR/apps/providers/$n/"
  [ -d "$p" ] || { warn "provider '$n' is needed but not present — reconciliation will name it"; continue; }
  # A LOCKFILE THAT EXISTS IS NOT A LOCKFILE THAT WORKS.
  #
  # This branched on the file's EXISTENCE and committed to `npm ci`. A provider
  # shipped a STUB lockfile — one entry, locking nothing, against a package.json
  # with real dependencies — and `npm ci` correctly refused it, which killed the
  # provision. Present-but-unusable is WORSE than absent: absent fails at a point
  # the branch already handles, present sails past the file test and dies inside
  # npm. Presence standing in for meaning, the same shape as the other two defects
  # in the report that found this.
  #
  # So: try the fast, exact path, and if it refuses, SAY SO and take the slow one.
  # Do not pre-judge the file from its existence.
  if [ -f "$p/package-lock.json" ]; then
    printf '  %-16s npm ci (lockfile present)\n' "$n"
    if ! install_provider_deps "$n" "npm ci --prefix '$p' --no-audit --no-fund"; then
      warn "provider '$n': npm ci refused the lockfile (see above) — falling back to npm install"
      printf '  %-16s npm install (lockfile unusable)\n' "$n"
      install_provider_deps "$n" "npm install --prefix '$p' --no-audit --no-fund"
    fi
  else
    printf '  %-16s NO LOCKFILE -> npm install (declared deps: %s)\n' "$n" \
      "$($NODE_BIN -p "Object.keys(require('$p/package.json').dependencies||{}).length" 2>/dev/null || echo '?')"
    install_provider_deps "$n" "npm install --prefix '$p' --no-audit --no-fund"
  fi
done

# --- 5. install apps ---------------------------------------------------------
note "install apps"
for a in "${APP_LIST[@]}"; do
  printf '  %s\n' "$a"
  run "cd '$STUDIO_DIR/sdk' && OPENRIG_STUDIO_DIR='$STUDIO_DIR' '$NODE_BIN' tools/install-app.mjs '$STUDIO_DIR/apps/apps/$a' --enable"
done

# --- 6. persist: systemd user service + linger -------------------------------
# Binds 127.0.0.1 by design. Remote access is a SEPARATE deliberate act
# (tunnel or an owner-controlled proxy). Do not "fix" this with 0.0.0.0.
note "persist (systemd user service)"
UNIT_DIR="$HOME/.config/systemd/user"
LEGACY_UNIT="openrig-studio.service"

# ONE UNIT NAME PER STUDIO, NOT ONE PER BOX.
#
# The unit used to be `openrig-studio.service` for every studio, so a SECOND
# provision on the same box overwrote the FIRST one's unit and daemon-reloaded it.
# The old process kept running, so everything anyone would check said fine:
# `is-active` reported active and the original port answered 200 — both measuring
# the OLD process — while the DEFINITION already pointed somewhere else. The damage
# only appears at reboot, when the box starts the second studio and the first never
# comes back.
#
# Found by cloud-impl on a live box with a reboot scheduled and held: the real
# studio was serving happily while its unit pointed at a test studio that had
# FAILED its own verification. That reboot would have booted the broken one.
#
# The name is derived from STUDIO_DIR, so it is stable across reprovisions of the
# same studio and distinct between different ones. One box with several studios is
# a normal thing to want — testing a provision beside a live one is exactly how
# this was found.
STUDIO_SLUG=$(basename "$STUDIO_DIR" | tr -c 'a-zA-Z0-9_-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')
STUDIO_HASH=$(printf '%s' "$STUDIO_DIR" | cksum | cut -d' ' -f1)
UNIT_NAME="openrig-studio-${STUDIO_SLUG:-studio}-${STUDIO_HASH}.service"

# Which studio does an existing unit belong to? Read the DEFINITION, never the
# runtime — that is the whole lesson of this defect.
unit_studio_dir() {
  [ -f "$1" ] || return 1
  sed -n 's/^Environment=OPENRIG_STUDIO_DIR=//p' "$1" | head -1
}

if [ "$DRY_RUN" = 0 ]; then
  mkdir -p "$UNIT_DIR"

  # REFUSE RATHER THAN ADOPT — the same rule the port guard already applies to a
  # foreign studio. Rewriting our OWN unit is an ordinary reprovision and stays
  # allowed; rewriting somebody else's is the defect.
  EXISTING_DIR=$(unit_studio_dir "$UNIT_DIR/$UNIT_NAME" || true)
  if [ -n "${EXISTING_DIR:-}" ] && [ "$EXISTING_DIR" != "$STUDIO_DIR" ]; then
    warn "unit $UNIT_NAME already exists and belongs to a DIFFERENT studio:"
    warn "  its OPENRIG_STUDIO_DIR: $EXISTING_DIR"
    warn "  this run's:             $STUDIO_DIR"
    warn "Refusing to overwrite it. A hash collision on the studio path is the only"
    warn "way to reach this; rename or remove that unit deliberately."
    exit 6
  fi

  # The legacy shared name. If it points at THIS studio it is ours to retire; if it
  # points at another one, LEAVE IT ALONE and say so — that is the studio this
  # defect would have silently stolen.
  LEGACY_DIR=$(unit_studio_dir "$UNIT_DIR/$LEGACY_UNIT" || true)
  if [ -n "${LEGACY_DIR:-}" ] && [ "$LEGACY_DIR" != "$STUDIO_DIR" ]; then
    warn "a legacy $LEGACY_UNIT exists and belongs to ANOTHER studio ($LEGACY_DIR)."
    warn "  Leaving it untouched. This run installs $UNIT_NAME instead."
    warn "  That other studio should be reprovisioned to get its own named unit."
  fi

  cat > "$UNIT_DIR/$UNIT_NAME" <<UNIT
[Unit]
Description=OpenRig Studio
After=network.target

[Service]
Type=simple
Environment=OPENRIG_STUDIO_DIR=${STUDIO_DIR}
WorkingDirectory=${STUDIO_DIR}/sdk
ExecStart=${NODE_BIN} tools/studio.mjs --port ${STUDIO_PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  printf '  wrote %s\n' "$UNIT_DIR/$UNIT_NAME"

  # VERIFY THE DEFINITION AGAINST INTENT, not the runtime against hope.
  # `is-active` and a 200 on the port both measure whatever process is already
  # running, which is exactly what made this defect invisible. The only honest
  # check is that the unit we just wrote names the studio we just provisioned.
  WROTE_DIR=$(unit_studio_dir "$UNIT_DIR/$UNIT_NAME" || true)
  if [ "${WROTE_DIR:-}" != "$STUDIO_DIR" ]; then
    warn "the unit just written does not name this studio (got '${WROTE_DIR:-none}', expected '$STUDIO_DIR')"
    exit 6
  fi
  if ! grep -q -- "--port ${STUDIO_PORT}\b" "$UNIT_DIR/$UNIT_NAME"; then
    warn "the unit just written does not name this run's port ($STUDIO_PORT)"
    exit 6
  fi
  printf '  verified unit definition: studio=%s port=%s\n' "$STUDIO_DIR" "$STUDIO_PORT"

  # Retire OUR OWN legacy unit, once the replacement is written and verified.
  # Only when it names this same studio — the other case warned above and is left
  # strictly alone.
  if [ "${LEGACY_DIR:-}" = "$STUDIO_DIR" ]; then
    printf '  retiring legacy %s (same studio, now named %s)\n' "$LEGACY_UNIT" "$UNIT_NAME"
    run "systemctl --user disable --now $LEGACY_UNIT" || true
    rm -f "$UNIT_DIR/$LEGACY_UNIT"
  fi
fi
# A host without an init system is a real case — containers, minimal images —
# and the install has ALREADY SUCCEEDED by this point. Aborting here would throw
# away a working studio over the way it gets restarted. Degrade loudly instead:
# start it directly so the box is usable and verifiable, and say plainly that
# persistence is NOT configured rather than letting a green run imply it is.
# HAVE_SYSTEMD MEANS "A USER MANAGER IS REACHABLE", NOT "THE BINARY EXISTS".
#
# It used to mean the second, which is not the question anyone is asking. On a
# host where systemctl is installed but nothing is running it — a container with
# the package, or `systemctl --user` as root over SSH with no session bus, which
# is the classic no-session-bus case — every --user call fails with "Failed to connect to bus",
# and the FIRST one on this branch is `daemon-reload` through a bare eval under
# `set -euo pipefail`. So the run died after a fully successful install, which is
# the failure this branch was rewritten to remove: the fix removed one abort and
# left the one above it.
#
# Measured before changing it, in a container: stock image has no systemctl at
# all; `apt-get install systemd` yields a systemctl whose every --user call exits
# 1 on the bus. Two different hosts, one flag, opposite correct behaviour.
#
# show-environment is a read-only query that needs the bus, so it answers the
# real question without touching anything.
SYSTEMCTL_PRESENT=0
SYSTEMD_WHY=""
command -v systemctl >/dev/null 2>&1 && SYSTEMCTL_PRESENT=1
HAVE_SYSTEMD=0
if [ "$SYSTEMCTL_PRESENT" = 1 ]; then
  if SYSTEMD_WHY="$(systemctl --user show-environment 2>&1 >/dev/null)"; then
    HAVE_SYSTEMD=1
  fi
fi

# WHO OWNS THE PORT — asked once, used by both branches below.
#
# Three outcomes, not two, because "nothing is listening" and "someone else's
# studio is listening" call for OPPOSITE actions and collapsing them is how a
# stranger's studio gets adopted. The old check asked only whether something
# answered /api/contract: a server returning a body that is not a studio
# satisfied it, and two genuine studios on a box are indistinguishable by
# contractVersion/runtime/capabilities alone. The discriminator is
# manifest.consumer.dir — documented contract as of this slice, not a field that
# happened to be there. The decision itself lives in studio-identity.mjs so its
# cases are testable without standing up two studios.
# THE SHELL DOES NOT CLASSIFY. It asks and reads an exit code — 0 ours, 3
# foreign, 4 nothing-listening — because the first version of this classified in
# shell and could not express the three states: `curl -f` reports a refused
# connection and an HTTP 404 identically, so a foreign server answering 404 at
# /api/contract read as an EMPTY PORT, was launched into, and was then verified
# against with a green result. The model was right and the medium could not carry
# it. The probe now does its own TCP check first, and only a missing listener may
# be "nothing".
IDENT_MJS="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/studio-identity.mjs"
[ -f "$IDENT_MJS" ] || IDENT_MJS="$STUDIO_DIR/sdk/provision/studio-identity.mjs"
OVERLAY_DIR="$STUDIO_DIR/.runtime/surfaces"
PORT_STATE=nothing        # nothing | ours | foreign
PORT_WHY=""
if [ "$DRY_RUN" = 0 ]; then
  set +e
  PORT_WHY="$("$NODE_BIN" "$IDENT_MJS" "$STUDIO_PORT" "$OVERLAY_DIR")"
  PORT_RC=$?
  set -e
  case "$PORT_RC" in
    0) PORT_STATE=ours ;;
    3) PORT_STATE=foreign ;;
    4) PORT_STATE=nothing ;;
    # A probe that failed for any other reason must NOT be read as "the port is
    # free". Refusing is the recoverable direction; launching into an occupied
    # port and verifying against a stranger is not.
    *) PORT_STATE=foreign
       PORT_WHY="the port probe itself failed (exit ${PORT_RC}) — refusing to assume the port is free" ;;
  esac
fi

# A port held by something that is not this studio is fatal on EVERY branch, and
# it has to be fatal BEFORE the verifier runs. Reusing it would hand a green run
# to the wrong studio; launching into it dies on EADDRINUSE; and verifying
# against it passes on somebody else's surfaces. Refuse by name instead.
if [ "$PORT_STATE" = foreign ]; then
  warn "PORT ${STUDIO_PORT} IS NOT THIS STUDIO: ${PORT_WHY}"
  warn "Refusing to reuse it, launch into it, or verify against it. The install is complete;"
  warn "free the port or set STUDIO_PORT, then re-run — this run stops here deliberately."
  exit 5
fi

if [ "$HAVE_SYSTEMD" = 1 ]; then
  run "systemctl --user daemon-reload"
  # An occupied port used to abort the whole run HERE, through run()'s bare eval,
  # AFTER the install had fully succeeded: apps installed, studio.json rewritten,
  # service down, nothing reported. Throwing that away over the way a studio gets
  # restarted helps nobody, so the conflict is reported and verification still
  # happens. NOTE WHAT IS NOT CLAIMED: the running studio was NOT restarted, so
  # it is serving the rail it composed at its own boot, not necessarily this
  # run's studio.json.
  if [ "$PORT_STATE" = ours ]; then
    warn "port ${STUDIO_PORT} already served by this studio — NOT restarting it."
    warn "The running process keeps the rail it composed at ITS boot; this run's studio.json"
    warn "takes effect on the next restart. Continuing to verify what is actually running."
  else
    run "systemctl --user enable --now $UNIT_NAME"
    # The unit MANAGER's view of the definition, which is the one that survives a
    # reboot. The file on disk being right is necessary and not sufficient — a
    # daemon-reload that did not take would leave the manager holding the old one,
    # and every runtime check would still look healthy.
    #
    # THIS BRANCH ALWAYS SAYS SOMETHING. An earlier version printed nothing when
    # the query itself failed, so SILENCE meant both "verified" and "could not
    # ask" — a check that cannot fail, which is the shape this whole defect is
    # made of. Three outcomes, three distinct lines, none of them silence.
    SHOW_ERR=""
    if LOADED_DIR=$(systemctl --user show "$UNIT_NAME" -p Environment --value 2>/tmp/.openrig-show-err); then
      case "$LOADED_DIR" in
        *"OPENRIG_STUDIO_DIR=$STUDIO_DIR"*)
          printf '  verified: systemd holds the right definition for %s\n' "$UNIT_NAME" ;;
        *)
          warn "systemd's loaded definition for $UNIT_NAME does not name this studio."
          warn "  loaded: ${LOADED_DIR:-<empty>}"
          warn "  expected OPENRIG_STUDIO_DIR=$STUDIO_DIR"
          warn "  A reboot would start the wrong studio. Not failing the install — the"
          warn "  studio is running — but persistence is NOT verified." ;;
      esac
    else
      SHOW_ERR=$(head -2 /tmp/.openrig-show-err 2>/dev/null | tr '\n' ' ')
      warn "could not ask systemd what it loaded for $UNIT_NAME — persistence is NOT VERIFIED."
      warn "  reason: ${SHOW_ERR:-systemctl --user show returned non-zero with no message}"
      warn "  The unit FILE is correct (checked above); what is unconfirmed is whether the"
      warn "  manager picked it up. A daemon-reload that did not take looks identical to"
      warn "  success from every runtime check."
    fi
    rm -f /tmp/.openrig-show-err
  fi
else
  # REPORT WHICH of the two conditions this is. They are different facts and an
  # operator can act on the difference: a host with no init system is a container
  # or a minimal image and there is nothing to fix, whereas systemctl-present-
  # but-unreachable usually means no session bus or no linger, and IS fixable.
  # Saying only "no init system" on the second would send someone to install
  # something that is already installed.
  if [ "$SYSTEMCTL_PRESENT" = 1 ]; then
    warn "systemctl IS installed but NO USER MANAGER IS REACHABLE, so no unit can be enabled here."
    warn "  reason: ${SYSTEMD_WHY:-systemctl --user could not be queried}"
    warn "  usually a missing session bus (a --user call as root over SSH) or linger not enabled."
    warn "The install has SUCCEEDED; this is not a reason to throw it away."
  else
    warn "NO INIT SYSTEM on this host (no systemctl). The studio will NOT survive a reboot."
  fi
  warn "Starting it directly so the box is usable; persistence is NOT configured."
  if [ "$DRY_RUN" = 0 ]; then
    # Reuse what is already there. A blind relaunch dies on EADDRINUSE while the
    # survivor reloads the manifest this run just replaced, so the verifier below
    # races a reload it caused and reports a false FAIL on a healthy box.
    if [ "$PORT_STATE" = ours ]; then
      printf '  %s\n' "$PORT_WHY"
    else
      ( cd "$STUDIO_DIR/sdk" && OPENRIG_STUDIO_DIR="$STUDIO_DIR" \
          nohup "$NODE_BIN" tools/studio.mjs --port "$STUDIO_PORT" > "$STUDIO_DIR/studio.log" 2>&1 & )
      printf '  started directly (pid in %s/studio.log); NOT persistent\n' "$STUDIO_DIR"
    fi
  fi
fi

# linger: without it the user manager dies at logout and the studio with it.
if [ "$HAVE_SYSTEMD" = 0 ]; then
  # Two different reasons to skip, and the message says which. Enabling linger is
  # one of the things that would FIX an unreachable manager, so reporting it as
  # "not applicable" on that host would be wrong in the direction that hides a fix.
  if [ "$SYSTEMCTL_PRESENT" = 1 ]; then
    printf '  linger: skipped — no user manager is reachable, so there is nothing to keep alive\n'
  else
    printf '  linger: not applicable without an init system\n'
  fi
elif loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
  printf '  linger already enabled\n'
elif [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
  run "$SUDO loginctl enable-linger $(id -un)"
else
  warn "LINGER NOT SET and no root. Studio will NOT survive logout/reboot."
fi

# --- 7. verify BY EFFECT -----------------------------------------------------
# Not "did the command exit 0". Assert the rail carries the apps we declared,
# AND that a verb returns real data. Negative control included: a surface that
# must NOT exist. Without it, a check that always passes scores a perfect run.
note "verify by effect"
[ "$DRY_RUN" = 1 ] && { printf '  (dry-run: skipping)\n'; exit 0; }
BASE="http://127.0.0.1:${STUDIO_PORT}"
# Wait for the surfaces themselves, not for "/". The front answers throughout a
# manifest reload, so waiting on it means asserting mid-reload.
for i in $(seq 1 60); do
  ready=1
  for a in "${APP_LIST[@]}"; do
    curl -fsS "$BASE/surfaces/$a.html" >/dev/null 2>&1 || { ready=0; break; }
  done
  [ "$ready" = 1 ] && break
  sleep 1
done

FAIL=0
for a in "${APP_LIST[@]}"; do
  if curl -fsS "$BASE/surfaces/$a.html" >/dev/null 2>&1; then printf '  ok   surface %s\n' "$a"
  else printf '  FAIL surface %s\n' "$a"; FAIL=1; fi
done
# negative control — this must 404, or the check above proves nothing
if curl -fsS "$BASE/surfaces/definitely-not-an-app.html" >/dev/null 2>&1; then
  printf '  FAIL negative control returned 200 — surface check is meaningless\n'; FAIL=1
else printf '  ok   negative control 404s\n'; fi
# a verb returning REAL DATA, not just 200
if curl -fsS "$BASE/api/library" 2>/dev/null | head -c 1 | grep -qE '[{[]'; then
  printf '  ok   /api/library returned structured data\n'
else printf '  FAIL /api/library did not return JSON\n'; FAIL=1; fi

printf '\nRESULT %s\n' "$($NODE_BIN -e "console.log(JSON.stringify({ok:$FAIL===0,port:$STUDIO_PORT,studio:'$STUDIO_DIR',apps:process.argv.slice(1)}))" "${APP_LIST[@]}")"
exit $FAIL
