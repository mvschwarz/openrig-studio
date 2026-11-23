#!/usr/bin/env node
// Start only the requested ttyd listener. This attaches an existing Herdr
// session; it never opens a wall, creates a rig or launches an agent.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { teamClient } from "./herdr-client.mjs";
import { TTYD_QUIET, forwardTtydLog } from "./ttyd-log.mjs";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["shell", "team"].includes(mode)) {
  console.error("Usage: node tools/start-terminal.mjs shell|team");
  process.exit(2);
}
const socket = process.env[mode === "shell" ? "STUDIO_TERMINAL_SOCKET" : "STUDIO_TEAM_SOCKET"];
if (
  !socket ||
  !path.isAbsolute(socket) ||
  path.normalize(socket) !== socket ||
  Buffer.byteLength(socket) > 100
) {
  console.error(
    "Set the terminal socket to an absolute path of at most 100 bytes in a directory owned by this user.",
  );
  process.exit(2);
}
// Never replace a socket belonging to another listener, including a stale one.
if (fs.existsSync(socket)) {
  console.error("The socket path already exists; reconcile its existing listener first.");
  process.exit(2);
}
fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
process.umask(0o077);
let command;
if (mode === "team") {
  try {
    teamClient();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  command = [process.execPath, fileURLToPath(new URL("./herdr-client.mjs", import.meta.url))];
} else command = [process.env.SHELL || "/bin/sh", "-l"];
// Errors only (tools/ttyd-log.mjs): ttyd's default also prints a dozen notices at start and one for every page load, into
// the log of whatever started it (the Studio's boot log for the shell terminal).
const child = spawn(
  process.env.STUDIO_TTYD_BIN || "ttyd",
  [
    "-p",
    "0",
    "-i",
    socket,
    "-b",
    "/" + (mode === "shell" ? "terminal" : "team"),
    "-W",
    ...TTYD_QUIET,
    ...command,
  ],
  { stdio: ["inherit", "inherit", "pipe"] },
);
forwardTtydLog(child.stderr);
let ready = false,
  created = null,
  stopping = false;
const fail = (why) => {
  clearInterval(poll);
  clearTimeout(timeout);
  console.error(why);
  process.exitCode = 1;
  child.kill("SIGTERM");
};
// ttyd sets 0660 explicitly, ignoring umask, and it can do so just after the
// socket appears. Tighten only this listener's new socket to 0600, and report
// readiness once a later check still sees 0600, so ttyd's own chmod cannot
// undo it after the route is advertised.
const poll = setInterval(() => {
  try {
    const st = fs.lstatSync(socket);
    if (!st.isSocket() || st.uid !== process.getuid?.())
      return fail("ttyd did not create an owned Unix socket.");
    if ((st.mode & 0o777) !== 0o600) return fs.chmodSync(socket, 0o600);
    created = st;
    ready = true;
    clearInterval(poll);
    clearTimeout(timeout);
    console.log(`Terminal ready: /${mode === "shell" ? "terminal" : "team"}/`);
  } catch (e) {
    if (e.code !== "ENOENT") fail(`Could not prepare the terminal socket: ${e.message}`);
  }
}, 20);
const timeout = setTimeout(
  () =>
    fail("ttyd did not create the configured Unix socket within 5 seconds; stopping its process."),
  5000,
);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
child.once("error", (e) => {
  clearInterval(poll);
  clearTimeout(timeout);
  console.error(
    `Could not start ttyd: ${e.message}. Install ttyd and set STUDIO_TTYD_BIN if it is outside PATH.`,
  );
  process.exitCode = 1;
});
child.once("exit", (code) => {
  clearInterval(poll);
  clearTimeout(timeout);
  if (created) {
    try {
      const st = fs.lstatSync(socket);
      if (st.ino === created.ino && st.dev === created.dev) fs.unlinkSync(socket);
    } catch {}
  }
  if (!ready && !process.exitCode)
    console.error("ttyd ended before the configured Unix socket was ready.");
  process.exitCode ||= !ready ? 1 : stopping ? 0 : (code ?? 1);
});
