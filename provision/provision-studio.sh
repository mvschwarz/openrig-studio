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
#   ./provision-studio.sh                       # defaults
#   STUDIO_PORT=8890 STUDIO_USER=studio ./provision-studio.sh
#   ./provision-studio.sh --dry-run             # print plan, touch nothing
#
set -euo pipefail

SDK_REPO="${SDK_REPO:-https://github.com/mvschwarz/openrig-studio.git}"
APPS_REPO="${APPS_REPO:-https://github.com/mvschwarz/openrig-studio-apps.git}"
STUDIO_DIR="${STUDIO_DIR:-$HOME/studio}"
MEDIA_DIR="${MEDIA_DIR:-$HOME/media}"
STUDIO_PORT="${STUDIO_PORT:-8890}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# Explicit APPS is an instruction; absent APPS is a question answered after the
# clone (see "discover apps"). A hardcoded default list silently rots: the apps
# repository moves on its own schedule, and a provisioner pinned to yesterday's
# names fails on a box that did nothing wrong.
APPS_EXPLICIT="${APPS:+yes}"
APPS="${APPS:-}"
# Split ONCE, explicitly, into an array. The obvious `for a in $APPS` relies on
# unquoted word-splitting, which bash does and zsh does NOT — so the same line
# yields six apps in a script and one fused string pasted into a zsh terminal,
# producing a studio.json that is still VALID JSON and completely wrong. An
# array removes the shell-dependency instead of documenting it.
read -ra APP_LIST <<< "$APPS"   # may be empty here; filled after the clone
DRY_RUN=0
# NOT `[ ... ] && DRY_RUN=1` — but the reason is narrower than this comment used
# to claim, and review-r1 measured it. A failing `&&`-tail does NOT trip `set -e`
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
    APP_LIST=(); for d in "$STUDIO_DIR"/apps/apps/*/; do [ -d "$d" ] && APP_LIST+=("$(basename "$d")"); done
    printf '  discovered %d app(s) from the repository: %s\n' "${#APP_LIST[@]}" "${APP_LIST[*]}"
    [ "${#APP_LIST[@]}" -gt 0 ] || { warn "no apps found under $STUDIO_DIR/apps/apps — refusing to write an empty studio"; exit 3; }
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
for p in "$STUDIO_DIR"/apps/providers/*/; do
  n=$(basename "$p")
  if [ -f "$p/package-lock.json" ]; then
    printf '  %-16s npm ci (lockfile present)\n' "$n"; run "npm ci --prefix '$p' --silent"
  else
    printf '  %-16s NO LOCKFILE -> npm install (declared deps: %s)\n' "$n" \
      "$($NODE_BIN -p "Object.keys(require('$p/package.json').dependencies||{}).length" 2>/dev/null || echo '?')"
    run "npm install --prefix '$p' --silent --no-audit --no-fund"
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
if [ "$DRY_RUN" = 0 ]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/openrig-studio.service" <<UNIT
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
  printf '  wrote %s\n' "$UNIT_DIR/openrig-studio.service"
fi
# A host without an init system is a real case — containers, minimal images —
# and the install has ALREADY SUCCEEDED by this point. Aborting here would throw
# away a working studio over the way it gets restarted. Degrade loudly instead:
# start it directly so the box is usable and verifiable, and say plainly that
# persistence is NOT configured rather than letting a green run imply it is.
HAVE_SYSTEMD=0
command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMD=1
if [ "$HAVE_SYSTEMD" = 1 ]; then
  run "systemctl --user daemon-reload"
  run "systemctl --user enable --now openrig-studio.service"
else
  warn "NO INIT SYSTEM on this host (no systemctl). The studio will NOT survive a reboot."
  warn "Starting it directly so the box is usable; persistence is NOT configured."
  if [ "$DRY_RUN" = 0 ]; then
    # Reuse what is already there. A blind relaunch dies on EADDRINUSE while the
    # survivor reloads the manifest this run just replaced, so the verifier below
    # races a reload it caused and reports a false FAIL on a healthy box.
    if curl -fsS "http://127.0.0.1:${STUDIO_PORT}/api/contract" >/dev/null 2>&1; then
      printf '  studio already serving on %s — reusing it\n' "$STUDIO_PORT"
    else
      ( cd "$STUDIO_DIR/sdk" && OPENRIG_STUDIO_DIR="$STUDIO_DIR" \
          nohup "$NODE_BIN" tools/studio.mjs --port "$STUDIO_PORT" > "$STUDIO_DIR/studio.log" 2>&1 & )
      printf '  started directly (pid in %s/studio.log); NOT persistent\n' "$STUDIO_DIR"
    fi
  fi
fi

# linger: without it the user manager dies at logout and the studio with it.
if [ "$HAVE_SYSTEMD" = 0 ]; then
  printf '  linger: not applicable without an init system\n'
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
